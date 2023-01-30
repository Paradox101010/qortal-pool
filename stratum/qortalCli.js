const events = require('events');



// Main qortalCli Function
const qortalCli = function(config, socket, id, authorizeFn) {

  const _this = this;
  this.id = id;
  this.config = config;
  this.socket = socket;
  this.authorizeFn = authorizeFn;

  // qortalCli Variables
  this.activity = Date.now();
  this.authorized = false;
  this.difficulty = 0;
  this.messages = '';
  this.shares = { valid: 0, invalid: 0 };

  // Difficulty Variables
  this.pendingDifficulty = null;
  this.staticDifficulty = false;

  // Send JSON Messages
  this.sendJson = function() {
    let response = '';
    Object.keys(arguments).forEach((arg) => {
      response += JSON.stringify(arguments[arg]) + '\n';
    });
    _this.socket.write(response);
  };

  // Get Label of Stratum qortalCli
  this.sendLabel = function() {
    const worker = _this.addrPrimary || '(unauthorized)';
    const address = _this.socket.remoteAddress;
    return `${ worker } [${ address }]`;
  };

  // Push Updated Difficulty to Queue
  this.enqueueDifficulty = function(difficulty) {
    if (!_this.staticDifficulty) {
      _this.pendingDifficulty = difficulty;
      _this.emit('qortalCli.difficulty.queued', difficulty);
    }
  };

  // Validate qortalCli Name
  this.validateName = function(name) {
    if (name.length >= 1) {
      name = name.toString().replace(/[^a-zA-Z0-9.,_-]+/g, '');
    }
    const addresses = name.split(',');
    if (addresses.length > 1) {
      return [addresses[0], addresses[1]];
    } else {
      return [addresses[0], null];
    }
  };

  // Validate qortalCli Password
  this.validatePassword = function(password) {
    if (password.length >= 1) {
      password = password.toString().replace(/[^a-zA-Z0-9.,=]+/g, '');
    }
    const values = password.split(',');
    const flags = {};
    values.forEach((value) => {
      if (/^d=[+-]?(\d*\.)?\d+$/.test(value)) {
        flags.difficulty = parseFloat(value.split('=')[1]);
      }
    });
    return flags;
  };

  // Validate Sent Messages
  this.validateMessages = function(message) {
    switch (message.method) {

    // Supported Stratum Messages
    case 'mining.subscribe':
      _this.handleSubscribe(message);
      break;
    case 'mining.authorize':
      _this.handleAuthorize(message);
      break;
    case 'mining.configure':
      _this.handleConfigure(message);
      break;
    case 'mining.multi_version':
      _this.handleMultiVersion(message);
      break;
    case 'mining.submit':
      _this.activity = Date.now();
      _this.handleSubmit(message);
      break;

      // Unsupported Stratum Messages
    case 'mining.get_transactions':
      _this.sendJson({
        id: message.id,
        result: [],
        error: [20, 'Not supported.', null]
      });
      break;
    case 'mining.extranonce.subscribe':
      _this.sendJson({
        id: message.id,
        result: false,
        error: [20, 'Not supported.', null]
      });
      break;
    default:
      _this.emit('qortalCli.mining.unknown', message);
      break;
    }
  };

  // Validate Socket Data
  this.validateData = function(data) {

    // qortalCli is Flooding Server
    _this.messages += data;
    if (Buffer.byteLength(_this.messages, 'utf8') > 10240) {
      _this.emit('qortalCli.socket.flooded');
      _this.socket.destroy();
      return;
    }

    // Handle Individual Messages
    if (_this.messages.indexOf('\n') !== -1) {
      const messages = _this.messages.split('\n');
      const incomplete = _this.messages.slice(-1) === '\n' ? '' : messages.pop();
      messages.forEach((message) => {
        if (message === '') return;
        try {
          _this.validateMessages(JSON.parse(message));
        } catch(e) {
          _this.emit('qortalCli.socket.malformed', e);
          _this.socket.destroy();
          return;
        }
      });
      _this.messages = incomplete;
    }
  };

  // Check for Banning Users
  this.considerBan = function(shareValid) {

    // Keep Track of Valid/Invalid Shares
    if (shareValid === true) _this.shares.valid += 1;
    else _this.shares.invalid += 1;

    // Check if Tracked Shares Exceeds Ban Threshold
    const totalShares = _this.shares.valid + _this.shares.invalid;
    if (totalShares >= _this.config.settings.banning.checkThreshold) {
      if (((_this.shares.invalid / totalShares) * 100) < _this.config.settings.banning.invalidPercent) {
        this.shares = { valid: 0, invalid: 0 };
      } else {
        _this.socket.destroy();
        _this.emit('qortalCli.ban.trigger');
        return true;
      }
    }

    // No Ban Necessary
    return false;
  };

  // Broadcast Difficulty to Stratum qortalCli
  this.broadcastDifficulty = function(difficulty) {

    // Handle Previous Difficulty
    if (difficulty === _this.difficulty) return false;
    _this.previousDifficulty = _this.difficulty;
    _this.difficulty = difficulty;

    // Process Algorithm Difficulty
    _this.sendJson({
      id: null,
      method: 'mining.set_difficulty',
      params: [difficulty],
    });

    // Difficulty Updated Correctly
    return true;
  };

  // Broadcast Mining Job to Stratum qortalCli
  this.broadcastMiningJob = function(parameters) {

    // Check Processed Shares
    const activityAgo = Date.now() - _this.activity;
    if (activityAgo > _this.config.settings.timeout.connection) {
      const message = `The last submitted share was ${ activityAgo / 1000 | 0 } seconds ago`;
      _this.emit('qortalCli.socket.timeout', message);
      _this.socket.destroy();
      return;
    }

    // Update qortalCli Difficulty
    if (_this.pendingDifficulty != null) {
      const result = _this.broadcastDifficulty(_this.pendingDifficulty);
      if (result) _this.emit('qortalCli.difficulty.updated', _this.difficulty);
      _this.pendingDifficulty = null;
    }

    // Broadcast Mining Job to qortalCli
    _this.sendJson({
      id: null,
      method: 'mining.notify',
      params: parameters
    });
  };

  // Manage Stratum Subscription
  this.handleSubscribe = function(message) {

    // Emit Subscription Event
    _this.emit('qortalCli.subscription', {}, (error, extraNonce1, extraNonce2Size) => {
      if (error) {
        _this.sendJson({ id: message.id, result: null, error: error });
        return;
      }

      // Assign qortalCli ExtraNonce
      _this.extraNonce1 = extraNonce1;
      _this.sendJson({
        id: message.id,
        result: [[
          ['mining.set_difficulty', _this.id],
          ['mining.notify', _this.id]],
        extraNonce1,
        extraNonce2Size],
        error: null
      });
    });
  };

  // Manage Stratum Authorization
  this.handleAuthorize = function(message) {

    // Handle qortalCli Authentication
    const qortalCliAddrs = _this.validateName(message.params[0]);
    const qortalCliFlags = _this.validatePassword(message.params[1]);

    // Set Initial Variables
    _this.addrPrimary = qortalCliAddrs[0];
    _this.addrmergedMining = qortalCliAddrs[1];
    _this.qortalCliPassword = message.params[1];

    // Check for Difficulty Flag
    if (qortalCliFlags.difficulty) {
      _this.enqueueDifficulty(qortalCliFlags.difficulty);
      _this.staticDifficulty = true;
    }

    // Check to Authorize qortalCli
    _this.authorizeFn(
      _this.socket.remoteAddress,
      _this.socket.localPort,
      _this.addrPrimary,
      _this.addrmergedMining,
      _this.qortalCliPassword,
      (result) => {
        _this.authorized = (!result.error && result.authorized);
        if (result.disconnect) {
          _this.socket.destroy();
          return;
        }
        _this.sendJson({
          id: message.id,
          result: _this.authorized,
          error: result.error
        });
      });
  };

  // Manage Stratum Configuration
  this.handleConfigure = function(message) {

    // Broadcast Version Updates
    _this.sendJson({
      id: message.id,
      result: {
        'version-rolling': true,
        'version-rolling.mask': '1fffe000'
      },
      error: null
    });

    // Update Version Mask
    _this.asicboost = true;
    _this.versionMask = '1fffe000';
  };

  // Manage Stratum Multi-Versions
  this.handleMultiVersion = function(message) {

    // Parse Version of Coin
    const mVersion = parseInt(message.params[0]);

    // Check if AsicBoost is Supported
    if (mVersion > 1) {
      _this.asicboost = true;
      _this.versionMask = '1fffe000';
    } else {
      _this.asicboost = false;
      _this.versionMask = '00000000';
    }
  };

  // Manage Stratum Submission
  this.handleSubmit = function(message) {

    // Check that Address is Set
    if (!_this.addrPrimary) {
      const workerData = _this.validateName(message.params[0]);
      _this.addrPrimary = workerData[0];
      _this.addrmergedMining = workerData[1];
    }

    // Check that qortalCli is Authorized
    if (!_this.authorized) {
      _this.sendJson({
        id: message.id,
        result: null,
        error: [24, 'unauthorized worker', null]
      });
      _this.considerBan(false);
      return;
    }

    // Check that qortalCli is Subscribed
    if (!_this.extraNonce1) {
      _this.sendJson({
        id: message.id,
        result: null,
        error: [25, 'not subscribed', null]
      });
      _this.considerBan(false);
      return;
    }

    // Submit Share to Pool Server
    message.params[0] = _this.validateName(message.params[0]);
    _this.emit('qortalCli.submit', message, (error, result) => {
      if (!_this.considerBan(result)) {
        _this.sendJson({
          id: message.id,
          result: result,
          error: error
        });
      }
    });
  };

  // Establish Stratum Connection
  this.setupqortalCli = function() {

    // Setup Main Socket Connection
    _this.socket.setEncoding('utf8');
    _this.emit('qortalCli.ban.check');

    // Process Socket Events
    _this.socket.on('data', (data) => _this.validateData(data));
    _this.socket.on('error', (error) => _this.emit('qortalCli.socket.error', error));
    _this.socket.on('close', () => _this.emit('qortalCli.socket.disconnect'));
  };
};

module.exports = qortalCli;
qortalCli.prototype.__proto__ = events.EventEmitter.prototype;