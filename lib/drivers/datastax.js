'use strict';

var _ = require('lodash')
  , util = require('util')
  , uuid = require('uuid')
  , BaseDriver = require('./base-driver')
  , cqlDriver = require('cassandra-driver');


function DatastaxDriver() {
  BaseDriver.call(this);
  var consistencies = cqlDriver.types.consistencies;
  this.hostConfigKey = 'contactPoints';
  this.dataType = _.extend(this.dataType, cqlDriver.types.dataTypes);
  this.consistencyLevel = {
    ONE: consistencies.one,
    one: consistencies.one,
    TWO: consistencies.two,
    two: consistencies.two,
    THREE: consistencies.three,
    three: consistencies.three,
    QUORUM: consistencies.quorum,
    quorum: consistencies.quorum,
    LOCAL_QUORUM: consistencies.localQuorum,
    localQuorum: consistencies.localQuorum,
    LOCAL_ONE: consistencies.localOne,
    localOne: consistencies.localOne,
    EACH_QUORUM: consistencies.eachQuorum,
    eachQuorum: consistencies.eachQuorum,
    ALL: consistencies.all,
    all: consistencies.all,
    ANY: consistencies.any,
    any: consistencies.any
  };
}
util.inherits(DatastaxDriver, BaseDriver);

module.exports = function (context) {
  var driver = new DatastaxDriver();
  driver.init(context);
  return driver;
};
module.exports.DatastaxDriver = DatastaxDriver;

DatastaxDriver.prototype.initProviderOptions = function init(config) {
  setHelenusOptions(config);
  config.supportsPreparedStatements = true;
};

DatastaxDriver.prototype.createConnectionPool = function createConnectionPool(poolConfig, waitForConnect, callback) {
  var self = this
    , openRequestId = uuid.v4()
    , pool;

  self.logger.debug('priam.Driver: Creating new pool', {
    poolConfig: {
      keyspace: poolConfig.keyspace,
      contactPoints: poolConfig.contactPoints
    }
  });

  var dsPoolConfig = _.cloneDeep(poolConfig);
  if (dsPoolConfig.username && dsPoolConfig.password) {
    dsPoolConfig.authProvider = new cqlDriver.auth.PlainTextAuthProvider(dsPoolConfig.username, dsPoolConfig.password);
  }

  dsPoolConfig.queryOptions = dsPoolConfig.queryOptions || {};
  dsPoolConfig.queryOptions.fetchSize = dsPoolConfig.limit;
  dsPoolConfig.queryOptions.prepare = false;
  if (dsPoolConfig.consistencyLevel) {
    dsPoolConfig.queryOptions.consistency = dsPoolConfig.consistencyLevel;
  }
  var port = null;
  if (Array.isArray(dsPoolConfig.contactPoints)) {
    for (var i = 0; i < dsPoolConfig.contactPoints.length; i++) {
      var split = dsPoolConfig.contactPoints[i].split(':');
      dsPoolConfig.contactPoints[i] = split[0].trim();
      if (split.length > 1) {
        port = +(split[1].trim());
      }
    }
    if (port !== null) {
      dsPoolConfig.protocolOptions = dsPoolConfig.protocolOptions || {};
      dsPoolConfig.protocolOptions.port = port;
    }
  }

  pool = new cqlDriver.Client(dsPoolConfig);
  pool.storeConfig = poolConfig;
  pool.waiters = [];
  pool.isReady = false;
  pool.on('log', function (level, message, data) {
    self.emit('connectionLogged', level, message, data);
    // unrecoverable errors will yield error on execution, so treat these as warnings since they'll be retried
    // treat everything else as debug information.
    var logMethod = (level === 'error' || level === 'warning') ? 'warn' : 'debug';

    var metaData = {
      datastaxLogLevel: level,
      data: data
    };
    self.logger[logMethod]('priam.Driver: ' + message, metaData);
  });

  this.emit('connectionOpening', openRequestId);
  pool.connect(function (err) {
    if (err) {
      self.emit('connectionFailed', openRequestId, err);
      self.logger.error('priam.Driver: Pool Connect Error',
        { name: err.name, error: err.message, inner: err.innerErrors });
      if (waitForConnect) {
        callback(err, pool);
      }
      self.callWaiters(err, pool);
      return void self.closePool(pool);
    }
    pool.isReady = true;
    self.emit('connectionOpened', openRequestId);
    if (waitForConnect) {
      callback(null, pool);
    }
    self.callWaiters(null, pool);
  });
  if (!waitForConnect) {
    callback(null, pool);
  }
};

DatastaxDriver.prototype.remapConnectionOptions = function remapConnectionOptions(connectionData) {
  remapOption(connectionData, 'user', 'username');
  remapOption(connectionData, 'hosts', 'contactPoints');
};

DatastaxDriver.prototype.closePool = function closePool(pool, callback) {
  if (pool.isReady && !pool.isClosed) {
    pool.isClosed = true;
    pool.isReady = false;
    pool.shutdown(callback);
  }
  else if (_.isFunction(callback)) {
    pool.isClosed = true;
    pool.isReady = false;
    process.nextTick(callback);
  }
  this.emit('connectionClosed');
};

DatastaxDriver.prototype.executeCqlOnDriver = function executeCqlOnDriver(pool, cqlStatement, params, consistency, options, callback) {
  var execOptions = _.assign({
    prepare: !!options.executeAsPrepared,
    consistency: consistency
  }, options);
  var hints = [];
  _.forEach(params, function (param, index) {
    if (param && param.hasOwnProperty('value') && param.hasOwnProperty('hint')) {
      params[index] = param.value;
      if (param.hint) {
        hints[index] = param.hint;
      }
    }
  });
  if (hints.length) {
    execOptions.hints = hints;
  }

  pool.execute(cqlStatement, params, execOptions, function (err, data) {
    if (err) {
      return void callback(err);
    }
    var result = (data && data.rows) ? data.rows : [];
    return void callback(null, result);
  });
};

DatastaxDriver.prototype.getNormalizedResults = function getNormalizedResults(original, options) {
  var self = this;
  var results = _.map(original, function (row) {
    var result = {};
    _.forOwn(row, function (value, name) {
      if (name === 'columns' && _.isObject(value)) { return; } // skip metadata
      if (typeof value === 'string') {
        value = self.checkObjectResult(value, name, options);
      }
      result[name] = value;
    });
    return result;
  });
  return results;
};

var numberRegex = /^[0-9]+$/;
DatastaxDriver.prototype.dataToCql = function dataToCql(val) {
  if (val && val.hasOwnProperty('value') && val.hasOwnProperty('hint')) {

    // Transform timestamp values into Date objects if number or string
    if (val.hint === this.dataType.timestamp) {
      if (typeof val.value === 'number') {
        val.value = new Date(val.value);
      }
      else if (typeof val.value === 'string') {
        if (numberRegex.test(val.value)) {
          val.value = new Date(parseInt(val.value, 10)); // string of numbers
        }
        else {
          val.value = new Date(val.value); // assume ISO string
        }
      }
    }

    return val; // {value,hint} style parameter - hint will be extracted out on the execute step
  }

  if (!Buffer.isBuffer(val) && (util.isArray(val) || typeof val === 'object')) {
    // arrays and objects should be JSON'ized
    return JSON.stringify(val);
  }

  return val; // use as-is
};

function remapOption(config, from, to) {
  if (config.hasOwnProperty(from)) {
    config[to] = config[from];
    delete config[from];
  }
}

function setHelenusOptions(config) {
  remapOption(config, 'timeout', 'getAConnectionTimeout'); // TODO: Implement
  remapOption(config, 'hostPoolSize', 'poolSize'); // TODO: Implement
  remapOption(config, 'cqlVersion', 'version');
  remapOption(config, 'user', 'username');
  remapOption(config, 'hosts', 'contactPoints');
}
