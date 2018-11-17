const { Server } = require('http');
const { Nuxt } = require('nuxt');
const { Bridge } = require('./now__bridge.js');

// Require Nuxt config
const config = require('./nuxt.config.js');

// Create a new Nuxt instance
const nuxt = new Nuxt(config);

const bridge = new Bridge();
bridge.port = 3000;

process.env.NODE_ENV = 'production';

const server = new Server((req, res) => {
  nuxt.renderRoute('PATHNAME_PLACEHOLDER', { req, res });
});
server.listen(bridge.port);

exports.launcher = bridge.launcher;
