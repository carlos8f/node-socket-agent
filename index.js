var util = require('util')
  , net = require('net')
  , EventEmitter = require('events').EventEmitter

// Largely copied from https://github.com/joyent/node/blob/master/lib/http.js
function Agent(options) {
  EventEmitter.call(this);

  var self = this;
  self.options = options || {};
  self.requests = {};
  self.sockets = {};
  self.maxSockets = self.options.maxSockets || Agent.defaultMaxSockets;
  self.on('free', function(socket, host, port, localAddress) {
    var name = host + ':' + port;
    if (localAddress) {
      name += ':' + localAddress;
    }

    if (self.requests[name] && self.requests[name].length) {
      self.requests[name].shift().call(null, socket);
      if (self.requests[name].length === 0) {
        // don't leak
        delete self.requests[name];
      }
    } else {
      // If there are no pending requests just destroy the
      // socket and it will get removed from the pool. This
      // gets us out of timeout issues and allows us to
      // default to Connection:keep-alive.
      socket.destroy();
    }
  });
  self.createConnection = net.createConnection;
}
util.inherits(Agent, EventEmitter);
module.exports = Agent;

Agent.defaultMaxSockets = 5;

Agent.prototype.defaultPort = 80;
Agent.prototype.addRequest = function(host, port, localAddress, cb) {
  if (typeof localAddress === 'function') {
    cb = localAddress;
    localAddress = null;
  }
  var name = host + ':' + port;
  if (localAddress) {
    name += ':' + localAddress;
  }
  if (!this.sockets[name]) {
    this.sockets[name] = [];
  }
  if (this.sockets[name].length < this.maxSockets) {
    // If we are under maxSockets create a new one.
    cb(this.createSocket(name, host, port, localAddress));
  } else {
    // We are over limit so we'll add it to the queue.
    if (!this.requests[name]) {
      this.requests[name] = [];
    }
    this.requests[name].push(cb);
  }
};
Agent.prototype.createSocket = function(name, host, port, localAddress) {
  var self = this;
  var options = util._extend({}, self.options);
  options.port = port;
  options.host = host;
  options.localAddress = localAddress;

  options.servername = host;

  var s = self.createConnection(options);
  if (!self.sockets[name]) {
    self.sockets[name] = [];
  }
  this.sockets[name].push(s);
  var onFree = function() {
    self.emit('free', s, host, port, localAddress);
  }
  s.on('free', onFree);
  var onClose = function(err) {
    // This is the only place where sockets get removed from the Agent.
    // If you want to remove a socket from the pool, just close it.
    // All socket errors end in a close event anyway.
    self.removeSocket(s, name, host, port, localAddress);
  }
  s.on('close', onClose);
  var onRemove = function() {
    // We need this function for cases like HTTP 'upgrade'
    // (defined by WebSockets) where we need to remove a socket from the pool
    //  because it'll be locked up indefinitely
    self.removeSocket(s, name, host, port, localAddress);
    s.removeListener('close', onClose);
    s.removeListener('free', onFree);
    s.removeListener('agentRemove', onRemove);
  }
  s.on('agentRemove', onRemove);
  return s;
};
Agent.prototype.removeSocket = function(s, name, host, port, localAddress) {
  if (this.sockets[name]) {
    var index = this.sockets[name].indexOf(s);
    if (index !== -1) {
      this.sockets[name].splice(index, 1);
      if (this.sockets[name].length === 0) {
        // don't leak
        delete this.sockets[name];
      }
    }
  }
  if (this.requests[name] && this.requests[name].length) {
    // If we have pending requests and a socket gets closed a new one
    this.createSocket(name, host, port, localAddress).emit('free');
  }
};