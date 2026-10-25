'use strict';

const { handleSync } = require('../lib/cloud-server');

module.exports = function handler(req, res) {
  return handleSync(req, res);
};
