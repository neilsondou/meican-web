'use strict';

const { handleLogout } = require('../lib/cloud-server');

module.exports = function handler(req, res) {
  return handleLogout(req, res);
};
