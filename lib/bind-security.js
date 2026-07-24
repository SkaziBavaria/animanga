'use strict';

function isOpenBind(host) {
  return host === '0.0.0.0' || host === '::';
}

module.exports = {
  isOpenBind,
};
