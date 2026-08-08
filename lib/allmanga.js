'use strict';

// Manga catalog uses ComicK (JSON API, no client crypto).
// Chapter page images are resolved through Weeb Central with curl (impersonation preferred).
module.exports = require('./comick');
