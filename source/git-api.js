var child_process = require('child_process');
var express = require('express');
var fs = require('fs');
var path = require('path');
var temp = require('temp');
var async=  require('async');
var git = require('./git');
var gitParser = require('./git-parser');
var winston = require('winston');
var usageStatistics = require('./usage-statistics');
var os = require('os');
var mkdirp = require('mkdirp');
var fileType = require('./utils/file-type.js');

exports.pathPrefix = '';

exports.registerApi = function(env) {
  var app = env.app;
  var server = env.server;
  var ensureAuthenticated = env.ensureAuthenticated || function(req, res, next) { next(); };
  var config = env.config;
  var io = env.socketIO;
  var socketsById = env.socketsById || {};

  if (config.dev)
    temp.track();

  if (io) {
    io.sockets.on('connection', function (socket) {
      socket.on('disconnect', function () {
        if (socket.watcher) {
          socket.watcher.close();
          socket.watcher = null;
          winston.info('Stop watching ' + socket.watcherPath);
        }
      });
      socket.on('watch', function (data, callback) {
        if (socket.watcher) {
          socket.leave(socket.watcherPath);
          socket.watcher.close(); // only one watcher per socket
          winston.info('Stop watching ' + socket.watcherPath);
        }
        socket.join(path.normalize(data.path)); // join room for this path
        socket.watcherPath = data.path;
        try {
          socket.watcher = fs.watch(data.path, function(event, filename) {
            // The .git dir changes on for instance 'git status', so we
            // can't trigger a change here (since that would lead to an endless
            // loop of the client getting the change and then requesting the new data)
            if (!filename || (filename != '.git' && filename.indexOf('.git/') != 0))
              socket.emit('working-tree-changed', { repository: data.path });
          });
          winston.info('Start watching ' + socket.watcherPath);
        } catch(err) {
          // Sometimes fs.watch crashes with errors such as ENOSPC (no space available)
          // which is pretty weird, but hard to do anything about, so we just log them here.
          usageStatistics.addEvent('fs-watch-exception');
        }
        if (callback) callback();
      });
    });
  }

  var ensurePathExists = function(req, res, next) {
    var path = req.param('path');
    if (!fs.existsSync(path)) {
      res.status(400).json({ error: 'No such path: ' + path, errorCode: 'no-such-path' });
    } else {
      next();
    }
  }

  var ensureValidSocketId = function(req, res, next) {
    var socketId = req.param('socketId');
    if (socketId == 'ignore') return next(); // Used in unit tests
    var socket = socketsById[socketId];
    if (!socket) {
      res.status(400).json({ error: 'No such socket: ' + socketId, errorCode: 'invalid-socket-id' });
    } else {
      next();
    }
  }

  var emitWorkingTreeChanged = function(repoPath) {
    if (io) {
      io.sockets.in(path.normalize(repoPath)).emit('working-tree-changed', { repository: repoPath });
      winston.info('emitting working-tree-changed to sockets, manually triggered');
    }
  }
  var emitGitDirectoryChanged = function(repoPath) {
    if (io) {
      io.sockets.in(path.normalize(repoPath)).emit('git-directory-changed', { repository: repoPath });
      winston.info('emitting git-directory-changed to sockets, manually triggered');
    }
  }

  function autoStashAndPop(path, gitTask) {
    if (config.autoStashAndPop) return git.stashAndPop(path, gitTask);
    else return gitTask;
  }

  var jsonFail = function(res, err) {
    res.status(400).json(err);
  }

  var jsonResultOrFail = function(res, err, result) {
    if (err) res.status(400).json(err);
    else res.json(result || {});
  }

  function credentialsOption(socketId) {
    var credentialsHelperPath = path.resolve(__dirname, '..', 'bin', 'credentials-helper').replace(/\\/g, '/');
    return ['-c', 'credential.helper="' + credentialsHelperPath + ' ' + socketId + ' ' + config.port + '"'];
  }

  app.get(exports.pathPrefix + '/status', ensureAuthenticated, ensurePathExists, function(req, res) {
    var repoPath = req.param('path');
    git.status(repoPath)
      .always(function(err, result) {
        if(result) {
          for(var file in result.files) {
            result.files[file].type = fileType(file);
          }
        }
        jsonResultOrFail(res, err, result);
      })
      .start();
  });

  app.post(exports.pathPrefix + '/init', ensureAuthenticated, ensurePathExists, function(req, res) {
    var arg = ['init'];
    if (req.param('bare')) {
      arg = arg.concat(['--bare', '--shared']);
    }
    git(arg, req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/clone', ensureAuthenticated, ensurePathExists, ensureValidSocketId, function(req, res) {
    // Default timeout is 2min but clone can take much longer than that (allows up to 2h)
    var timeoutMs = 2 * 60 * 60 * 1000;
    if (res.setTimeout) res.setTimeout(timeoutMs);

    var url = req.body.url.trim();
    if (url.indexOf('git clone ') == 0) url = url.slice('git clone '.length);
    git(credentialsOption(req.param('socketId')).concat(['clone', url, req.param('destinationDir').trim()]), req.param('path'))
      .timeout(timeoutMs)
      .fail(jsonFail.bind(null, res))
      .done(function(result) { res.json({ path: path.resolve(req.param('path'), req.param('destinationDir')) }); })
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/fetch', ensureAuthenticated, ensurePathExists, ensureValidSocketId, function(req, res) {
    // Allow a little longer timeout on fetch (10min)
    var timeoutMs = 10 * 60 * 1000;
    if (res.setTimeout) res.setTimeout(timeoutMs);

    git(credentialsOption(req.param('socketId')).concat([
        'fetch',
        req.param('remote'),
        req.param('ref') ? req.param('ref') : '',
        config.autoPruneOnFetch ? '--prune' : '']), req.param('path'))
      .timeout(10 * 60 * 1000)
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/push', ensureAuthenticated, ensurePathExists, ensureValidSocketId, function(req, res) {
    // Allow a little longer timeout on push (10min)
    var timeoutMs = 10 * 60 * 1000;
    if (res.setTimeout) res.setTimeout(timeoutMs);

    git(credentialsOption(req.param('socketId')).concat([
        'push',
        req.param('remote'),
        (req.body.refSpec ? req.body.refSpec : 'HEAD') + (req.body.remoteBranch ? ':' + req.body.remoteBranch : ''),
        (req.param('force') ? '-f' : '')]), req.param('path'))
      .timeout(10 * 60 * 1000)
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/reset', ensureAuthenticated, ensurePathExists, function(req, res) {
    autoStashAndPop(req.param('path'), git(['reset', '--', req.param('mode'), req.body.to], req.param('path')))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.get(exports.pathPrefix + '/diff', ensureAuthenticated, ensurePathExists, function(req, res) {
    var isGetRaw = req.param('isGetRaw') && req.param('isGetRaw') === 'true' ? true : false;
    git.diffFile(req.param('path'), req.param('file'), req.param('sha1'), parseInt(req.param('maxNLines')), isGetRaw)
      .always(jsonResultOrFail.bind(null, res))
      .start();
  });

  app.get(exports.pathPrefix + '/diff/image', ensureAuthenticated, ensurePathExists, function(req, res) {
    if (req.query.version !== 'current') {
      git.binaryFileContent(req.query.path, req.query.filename, req.query.version)
        .always(function(err, result) {
          res.type(path.extname(req.query.filename));
          if (err) res.status(400).json(err);
          else res.send(new Buffer(result, 'binary'));
        })
        .start();
    } else {
      res.sendfile(path.join(req.query.path, req.query.filename));
    }
  });

  app.post(exports.pathPrefix + '/discardchanges', ensureAuthenticated, ensurePathExists, function(req, res){
    var task;
    if (req.param('all')) task = git.discardAllChanges(req.param('path'));
    else task = git.discardChangesInFile(req.param('path'), req.param('file').trim());

    task
      .always(jsonResultOrFail.bind(null, res))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/ignorefile', ensureAuthenticated, ensurePathExists, function(req, res){
    var currentPath = req.param('path').trim();
    var gitIgnoreFile = currentPath + '/.gitignore';
    var ignoreFile = req.param('file').trim();
    var socket = socketsById[req.param('socketId')];

    if (!fs.existsSync(gitIgnoreFile)) fs.writeFileSync(gitIgnoreFile, '');

    fs.readFile(gitIgnoreFile, function(err, data) {

      var arrayOfLines = data.toString().match(/[^\r\n]+/g);
      if(arrayOfLines != null){
        for (var n = 0; n < arrayOfLines.length; n++) {
          if (arrayOfLines[n].trim() == ignoreFile) {
            return res.status(400).json({ errorCode: 'file-already-git-ignored', error: ignoreFile + ' already exist in .gitignore' });
          }
        }
      }

      fs.appendFile(gitIgnoreFile, os.EOL + ignoreFile, function(err) {
        if(err) {
          return res.status(400).json({ errorCode: 'error-appending-ignore', error: 'Error while appending to .gitignore file.' });
        } else {
          if(socket)
            socket.emit('working-tree-changed', { repository: currentPath });
          return res.json({});
        }
      });
    });
  });

  app.post(exports.pathPrefix + '/commit', ensureAuthenticated, ensurePathExists, function(req, res){
    git.commit(req.param('path'), req.param('amend'), req.param('message'), req.param('files'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/revert', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['revert', req.param('commit')], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.get(exports.pathPrefix + '/log', ensureAuthenticated, ensurePathExists, function(req, res){
    var limit = '';
    if (req.query.limit) limit = '--max-count=' + req.query.limit;

    git(['log', '--decorate=full', '--date=default', '--pretty=fuller', '--all', '--parents', '--numstat', '--topo-order', limit], req.param('path'))
      .parser(gitParser.parseGitLog)
      .always(function(err, log) {
        if (err) {
          if (err.stderr.indexOf('fatal: bad default revision \'HEAD\'') == 0)
            res.json([]);
          else if (err.stderr.indexOf('fatal: Not a git repository') == 0)
            res.json([]);
          else
            res.status(400).json(err);
        } else {
          res.json(log);
        }
      })
      .start();
  });

  app.get(exports.pathPrefix + '/show', ensureAuthenticated, function(req, res){
    git(['show', '--numstat', req.query.sha1], req.param('path'))
      .parser(gitParser.parseGitLog)
      .always(function(err, log) {
        if (err) {
          res.status(400).json(err);
        } else {
          res.json(log);
        }
      })
      .start();
  });

  app.get(exports.pathPrefix + '/head', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['log', '--decorate=full', '--pretty=fuller', '--parents', '--max-count=1'], req.param('path'))
      .parser(gitParser.parseGitLog)
      .always(function(err, log) {
        if (err) {
          if (err.stderr.indexOf('fatal: bad default revision \'HEAD\'') == 0)
            res.json([]);
          else if (err.stderr.indexOf('fatal: Not a git repository') == 0)
            res.json([]);
          else
            res.status(400).json(err);
        } else {
          res.json(log);
        }
      })
      .start();
  });

  app.get(exports.pathPrefix + '/branches', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['branch'], req.param('path'))
      .parser(gitParser.parseGitBranches)
      .always(jsonResultOrFail.bind(null, res))
      .start();
  });

  app.post(exports.pathPrefix + '/branches', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['branch', (req.body.force ? '-f' : ''), req.body.name.trim(), (req.body.startPoint || 'HEAD').trim()], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.delete(exports.pathPrefix + '/branches', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['branch', '-D', req.param('name').trim()], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.delete(exports.pathPrefix + '/remote/branches', ensureAuthenticated, ensurePathExists, ensureValidSocketId, function(req, res){
    git(credentialsOption(req.param('socketId')).concat(['push', req.param('remote'), ':' + req.param('name').trim()]), req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.get(exports.pathPrefix + '/tags', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['tag', '-l'], req.param('path'))
      .parser(gitParser.parseGitTags)
      .always(jsonResultOrFail.bind(null, res))
      .start();
  });

  app.get(exports.pathPrefix + '/remote/tags', ensureAuthenticated, ensurePathExists, ensureValidSocketId, function(req, res){
    git(credentialsOption(req.param('socketId')).concat(['ls-remote', '--tags', req.param('remote')]), req.param('path'))
      .parser(gitParser.parseGitLsRemote)
      .always(function(err, result) {
        if (err) return res.status(400).json(err);
        result.forEach(function(r) { r.remote = req.param('remote'); });
        res.json(result);
      })
      .start();
  });

  app.post(exports.pathPrefix + '/tags', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['tag', (req.body.force ? '-f' : ''), '-a', req.body.name.trim(), '-m',
        req.body.name.trim(), (req.body.startPoint || 'HEAD').trim()], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.delete(exports.pathPrefix + '/tags', ensureAuthenticated, ensurePathExists, function(req, res) {
    git(['tag', '-d', req.param('name').trim()], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.delete(exports.pathPrefix + '/remote/tags', ensureAuthenticated, ensurePathExists, function(req, res) {

    git(credentialsOption(req.param('socketId')).concat(['push', req.param('remote') + ' :"refs/tags' + req.param('name').trim() + '"']), req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/checkout', ensureAuthenticated, ensurePathExists, function(req, res){
    autoStashAndPop(req.param('path'), git(['checkout', req.body.name.trim()], req.param('path')))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/cherrypick', ensureAuthenticated, ensurePathExists, function(req, res){
    autoStashAndPop(req.param('path'), git(['cherry-pick', req.param('name').trim()], req.param('path')))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.get(exports.pathPrefix + '/checkout', ensureAuthenticated, ensurePathExists, function(req, res){
    git.getCurrentBranch(req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .start();
  });

  app.get(exports.pathPrefix + '/remotes', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['remote'], req.param('path'))
      .parser(gitParser.parseGitRemotes)
      .always(jsonResultOrFail.bind(null, res))
      .start();
  });

  app.get(exports.pathPrefix + '/remotes/:name', ensureAuthenticated, ensurePathExists, function(req, res){
    git.getRemoteAddress(req.param('path'), req.params.name)
      .always(jsonResultOrFail.bind(null, res))
      .start();
  });

  app.post(exports.pathPrefix + '/remotes/:name', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['remote', 'add', req.param('name'), req.param('url')], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .start();
  });

  app.post(exports.pathPrefix + '/merge', ensureAuthenticated, ensurePathExists, function(req, res) {
    var noFF = '';
    if (config.noFFMerge) noFF = '--no-ff';
    git(['merge', noFF, req.body.with.trim()], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/merge/continue', ensureAuthenticated, ensurePathExists, function(req, res) {
    git(['commit', '--file=-'], req.param('path'))
      .started(function() {
        this.process.stdin.end(req.param('message'));
      })
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/merge/abort', ensureAuthenticated, ensurePathExists, function(req, res) {
    git(['merge', '--abort'], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });


  app.post(exports.pathPrefix + '/rebase', ensureAuthenticated, ensurePathExists, function(req, res) {
    git(['rebase', req.body.onto.trim()], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/rebase/continue', ensureAuthenticated, ensurePathExists, function(req, res) {
    git(['rebase', '--continue'], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/rebase/abort', ensureAuthenticated, ensurePathExists, function(req, res) {
    git(['rebase', '--abort'], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.post(exports.pathPrefix + '/resolveconflicts', ensureAuthenticated, ensurePathExists, function(req, res) {
    git.resolveConflicts(req.param('path'), req.body.files)
      .always(jsonResultOrFail.bind(null, res))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.get(exports.pathPrefix + '/baserepopath', ensureAuthenticated, ensurePathExists, function(req, res){
    var currentPath = path.resolve(path.join(req.param('path'), '..'));
    while (currentPath != '/' &&
      (!fs.existsSync(path.join(currentPath, '.git')) ||
      !fs.statSync(path.join(currentPath, '.git')).isDirectory())) {
      currentPath = path.resolve(path.join(currentPath, '..'));
    }
    if (currentPath != '/') res.json({ path: currentPath });
    else res.status(404).json({});
  });

  app.get(exports.pathPrefix + '/submodules', ensureAuthenticated, ensurePathExists, function(req, res){
    var filename = path.join(req.param('path'), '.gitmodules');

    fs.exists(filename, function(exists) {
      if (!exists) {
        res.json({});
        return;
      }

      fs.readFile(filename, {encoding: 'utf8'}, function (err, data) {
        if (err) {
          res.json({});
        } else {
          res.json(gitParser.parseGitSubmodule(data));
        }
      });
    });
  });

  app.post(exports.pathPrefix + '/submodules/update', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['submodule', 'init'], req.param('path'))
      .always(function() {
        return git(['submodule', 'update'], req.param('path'))
        .always(jsonResultOrFail.bind(null, res))
        .start();
      })
      .start();
  });

  app.post(exports.pathPrefix + '/submodules/add', ensureAuthenticated, ensurePathExists, function(req, res) {
    git(['submodule', 'add', req.body.submoduleUrl.trim(), req.body.submodulePath.trim()], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.get(exports.pathPrefix + '/quickstatus', ensureAuthenticated, function(req, res){
    fs.exists(req.param('path'), function(exists) {
      if (!exists) {
        res.json('no-such-path');
        return;
      }

      git(['rev-parse', '--is-inside-work-tree'], req.param('path'))
        .always(function(err, result) {
          if (err || result.toString().indexOf('true') == -1) res.json('uninited');
          else res.json('inited');
        })
        .start();
    })
  });

  app.get(exports.pathPrefix + '/stashes', ensureAuthenticated, ensurePathExists, function(req, res){
    git(['stash', 'list', '--decorate=full', '--pretty=fuller'], req.param('path'))
      .parser(gitParser.parseGitLog)
      .always(function(err, items) {
        if (err) return res.status(400).json(err);
        res.json(items.map(function(item, index) {
          return {
            id: index,
            name: item.reflogName.slice('refs/'.length),
            title: item.message,
            date: item.commitDate
          }
        }));
      })
      .start();
  });

  app.post(exports.pathPrefix + '/stashes', ensureAuthenticated, ensurePathExists, function(req, res){
    var message = '';
    if (req.param('message')) message = req.param('message');
    git(['stash', 'save', '--include-untracked', message ], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.delete(exports.pathPrefix + '/stashes/:id', ensureAuthenticated, ensurePathExists, function(req, res){
    var type = 'drop';
    if (req.query.pop === 'true') type = 'pop';
    git(['stash', type, 'stash@{' + req.param('id') + '}'], req.param('path'))
      .always(jsonResultOrFail.bind(null, res))
      .always(emitGitDirectoryChanged.bind(null, req.param('path')))
      .always(emitWorkingTreeChanged.bind(null, req.param('path')))
      .start();
  });

  app.get(exports.pathPrefix + '/gitconfig', ensureAuthenticated, function(req, res){
    git(['config', '--list'])
      .parser(gitParser.parseGitConfig)
      .always(jsonResultOrFail.bind(null, res))
      .start();
  });

  // This method isn't called by the client but by credentials-helper.js
  app.get(exports.pathPrefix + '/credentials', function(req, res) {
    // this endpoint can only be invoked from localhost, since the credentials-helper is always
    // on the same machine that we're running ungit on
    if (req.ip != '127.0.0.1') {
      winston.info('Trying to get credentials from unathorized ip: ' + req.ip);
      res.status(400).json({ errorCode: 'request-from-unathorized-location' });
      return;
    }
    var socket = socketsById[req.param('socketId')];
    if (!socket) {
      // We're using the socket to display an authentication dialog in the ui,
      // so if the socket is closed/unavailable we pretty much can't get the username/password.
      winston.info('Trying to get credentials from unavailable socket: ' + req.param('socketId'));
      res.status(400).json({ errorCode: 'socket-unavailable' });
    } else {
      socket.once('credentials', function(data) {
        res.json(data);
      });
      socket.emit('request-credentials');
    }
  });

  app.post(exports.pathPrefix + '/createdir', ensureAuthenticated, function(req, res) {
    var dir = req.param('dir');
    if (!dir) {
      return res.status(400).json({ errorCode: 'missing-request-parameter', error: 'You need to supply the path request parameter' });
    }

    mkdirp(dir, function(err) {
      if (err) return res.status(400).json(err);
      else return res.json({});
    });
  });

  app.get(exports.pathPrefix + '/debug', ensureAuthenticated, function(req, res) {
    res.json({
      runningGitTasks: git.runningTasks.map(function(task) {
        return {
          path: task.repoPath,
          command: task.command,
          runningTime: (Date.now() - task.startTime) / 1000
        };
      })
    });
  });

  if (config.dev) {

    app.post(exports.pathPrefix + '/testing/createtempdir', ensureAuthenticated, function(req, res){
      temp.mkdir('test-temp-dir', function(err, path) {
        res.json({ path: path });
      });
    });
    app.post(exports.pathPrefix + '/testing/createfile', ensureAuthenticated, function(req, res){
      var content = req.body.content;
      if (req.body.content === undefined) content = ('test content\n' + Math.random() + '\n');
      fs.writeFileSync(req.param('file'), content);
      res.json({ });
    });
    app.post(exports.pathPrefix + '/testing/changefile', ensureAuthenticated, function(req, res){
      var content = req.param('content');
      if (content === undefined) content = ('test content\n' + Math.random() + '\n');
      fs.writeFileSync(req.param('file'), content);
      res.json({ });
    });
    app.post(exports.pathPrefix + '/testing/createimagefile', ensureAuthenticated, function(req, res){
      fs.writeFile(req.param('file'), 'png', {encoding: 'binary'});
      res.json({ });
    });
    app.post(exports.pathPrefix + '/testing/changeimagefile', ensureAuthenticated, function(req, res){
      fs.writeFile(req.param('file'), 'png ~~', {encoding: 'binary'});
      res.json({ });
    });
    app.post(exports.pathPrefix + '/testing/removefile', ensureAuthenticated, function(req, res){
      fs.unlinkSync(req.param('file'));
      res.json({ });
    });
    app.post(exports.pathPrefix + '/testing/git', ensureAuthenticated, function(req, res){
      git(req.param('command'), req.param('repo'))
        .always(jsonResultOrFail.bind(null, res))
        .start();
    });
    app.post(exports.pathPrefix + '/testing/cleanup', ensureAuthenticated, function(req, res){
      var cleaned = temp.cleanup();
      //winston.info('Cleaned up: ' + JSON.stringify(cleaned));
      res.json({ result: cleaned });
    });
    app.post(exports.pathPrefix + '/testing/shutdown', ensureAuthenticated, function(req, res){
      res.json({ });
      process.exit();
    });
  }

};
