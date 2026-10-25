'use strict';

const { handleLogin } = require('../lib/cloud-server');

module.exports = function handler(req, res) {
  return handleLogin(req, res);
};
