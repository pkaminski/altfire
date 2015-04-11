angular.module('altfire', [])

/**
 * The main Firebase/Angular adapter service.
 */
.provider('fire', function() {

var root = null;
var defaultConstructorMap = {};

/**
 * Sets the default root for all Firebase data paths that don't include a host. You probably
 * want to set a root when your app initializes. Note that no distinction is made between
 * relative and absolute paths -- all have the full root prepended if they lack a host.
 * @param {string} rootUrl The root URL, usually something like 'https://foo.firebaseio.com' but
 * can also include a path component.
 */
this.setDefaultRoot = function(rootUrl) {
  if (!angular.isString(rootUrl)) {
    rootUrl = rootUrl.toString();
  }
  if (rootUrl.search(/^https?:\/\//) !== 0) {
    throw new Error('Firebase root URL must start with http(s)://, got: ' + rootUrl);
  }
  if (rootUrl.charAt(rootUrl.length - 1) !== '/') {
    rootUrl += '/';
  }
  root = rootUrl;
};

this.setDefaultConstructorMap = function(constructorMap) {
  defaultConstructorMap = angular.copy(constructorMap);
};


this.$get = ['$interpolate', '$q', '$timeout', '$rootScope', 'orderByFilter', 'fireHelpers',
    function($interpolate, $q, $timeout, $rootScope, orderByFilter, fireHelpers) {
  'use strict';
  var self = {};
  var constructorTable = [];
  var serverTimeOffset = 0;
  var reportedBadPaths = {};

  function buildConstructorTable() {
    constructorTable = [];
    angular.forEach(defaultConstructorMap, function(constructor, path) {
      var pathVariables = [];
      var pathTemplate = prefixRoot(path, true).replace(/\b\$[^\/]+/g, function(match) {
        pathVariables.push(match);
        return '([^/]+)';
      });
      constructorTable.push({
        constructor: constructor,
        variables: pathVariables,
        regex: new RegExp('^' + pathTemplate.replace(/[$-.?[-^{|}]/g, '\\$&') + '$')
      });
    });
  }
  buildConstructorTable();

  var createObject = function(path) {
    for (var i = 0; i < constructorTable.length; i++) {
      var descriptor = constructorTable[i];
      descriptor.regex.lastIndex = 0;
      var match = descriptor.regex.exec(path);
      if (match) {
        var o = new descriptor.constructor();
        for (var j = 0; j < descriptor.variables.length; j++) {
          Object.defineProperty(o, descriptor.variables[j], {value: match[j + 1]});
        }
        return o;
      }
    }
  };

  function normalizeSnapshotValue(snap) {
    var value = normalizeSnapshotValueHelper(snap.ref().toString(), snap.key(), snap.val());
    if (snap.hasChildren() && snap.getPriority() !== null) {
      Object.defineProperty(value, '.priority', {value: snap.getPriority()});
    }
    return value;
  }

  function getRefChild(path) {
    if (arguments.length > 1) {
      path += '/' + Array.prototype.slice.call(arguments, 1).join('/');
    }
    return new Firebase(path);
  }

  function normalizeSnapshotValueHelper(path, key, value) {
    var normalValue;
    if (angular.isArray(value)) normalValue = createObject(path) || {};
    else if (angular.isObject(value)) normalValue = createObject(path) || value;
    if (normalValue) {
      Object.defineProperty(normalValue, '$key', {value: key});
      Object.defineProperty(normalValue, '$ref', {value: angular.bind(null, getRefChild, path)});
      angular.forEach(value, function(item, childKey) {
        if (!(item === null || angular.isUndefined(item))) {
          normalValue[childKey] = normalizeSnapshotValueHelper(
            path + '/' + childKey, childKey, item);
        }
      });
    }
    return normalValue || value;
  }

  /**
   * Pretend that a value was retrieved from the given ref, and normalize and decorate it just like
   * values retrieved from Firebase.  This will turn all arrays into objects, and add a $key
   * property and $ref method to each object (recursively).  It does not modify the datastore in any
   * way, but may mutate the value that was passed in.
   * @param  {Firebase} ref The Firebase reference to which the value should be "attached".
   * @param  {Object} value The value to decorate.
   * @return {Object}       The decorated value.  May be a new object.
   */
  self.decorate = function(ref, value) {
    return normalizeSnapshotValueHelper(ref.toString(), ref.key(), value);
  };

  if (root) {
    var timeOffsetRef =
      new Firebase(root.slice(0, root.indexOf('/', 8) + 1) + '.info/serverTimeOffset');
    timeOffsetRef.on('value', function(snap) {serverTimeOffset = snap.val();});
  }

  self.getDefaultServerTimestamp = function() {
    return Date.now() + serverTimeOffset;
  };

  function prefixRoot(path, noWatch) {
    if (angular.isString(path)) {
      var isFullPath = path.slice(0, 8) === 'https://';
      if (path && ((isFullPath ? path.slice(8) : path).indexOf('//') !== -1 ||
          path.charAt(path.length - 1) === '/' || path.charAt(0) === '/')) {
        try {
          throw new Error('Invalid path interpolation: ' + path);
        } catch(e) {
          if (noWatch) throw e;
          if (!(path in reportedBadPaths)) {
            reportedBadPaths[path] = true;
            if (/\baltfire\b/.test(e.stack)) {
              console.log(e.stack.replace(/\n[^\n]*(altfire|angular(\.min)?)\.js[^\n]*$/gm, ''));
            }
          }
        }
        return undefined;
      }
      if (!isFullPath) {
        if (!root) throw new Error('Relative path given and default root not specified.');
        path = root + path;
      }
    }
    return path;
  }

  function expandPath(scope, path, viaPath, callback, noWatch) {
    if (!scope.$watch) noWatch = true;
    if (viaPath && path.search('#') === -1) {
      path += '/#';
    }
    var pathInterpolator = angular.isString(path) ? $interpolate(path, true) : undefined;
    var viaPathInterpolator = angular.isString(viaPath) ? $interpolate(viaPath, true) : undefined;

    if (!noWatch && scope.$watch && (pathInterpolator || viaPathInterpolator)) {
      scope.$watchGroup([pathInterpolator, viaPathInterpolator], function(paths) {
        paths[0] = prefixRoot(pathInterpolator ? paths[0] : path, noWatch);
        paths[1] = prefixRoot(viaPathInterpolator ? paths[1] : viaPath, noWatch);
        if (!(initialPaths && angular.equals(paths, initialPaths))) {
          initialPaths = null;
          callback.apply(null, paths);
        }
      }, true);
    }
    // Even if watching, issue the first callback synchronously so the handle will be valid
    // immediately.  But be careful -- it's possible for the interpolated paths to change between
    // now and the first watcher callback, in which case we'd miss an update unless we compare
    // against the paths we actually computed here.
    var initialPaths = [
      prefixRoot(pathInterpolator ? pathInterpolator(scope) : path, noWatch),
      prefixRoot(viaPathInterpolator ? viaPathInterpolator(scope) : viaPath, noWatch)
    ];
    callback.apply(null, initialPaths);
  }

  /**
   * Returns a Firebase reference for the given data path, interpolated with variables from the
   * given scope (or other context object).
   * @param  {Object} scope The scope to use for interpolation of the path.
   * @param  {string} path The path to convert into a reference.
   * @return {Firebase} The reference corresponding to the interpolated and root-prefixed path.
   * Note that this reference will not update if the scope's variable values change.
   */
  self.ref = function(scope, path) {
    return new Firebase(prefixRoot($interpolate(path)(scope)));
  };

  /**
   * Connects a single attribute to a value in the Firebase datastore.
   * @param  {Object} args An object with the following attributes:
   *    scope, name:  The destination object and the name of its attribute with which to connect the
   *        Firebase data (i.e., scope[name]).  Both are required.  The scope will also be used for
   *        interpolating the path unless a pathScope is provided.  If the scope is an Angular scope
   *        then the connection will automatically be destroyed with the scope; otherwise, you're
   *        responsible for calling destroy() on the returned handle yourself.
   *    pathScope:  An optional object used for interpolating the data path.
   *    bind, pull, once, noop:  The Firebase data path to connect to; exactly one of these
   *        arguments must be specified.  The path will be interpolated using the pathScope (or
   *        scope), and kept updated if that is an actual scope.  It will also be prefixed with the
   *        default root if no host is specified.  The meaning of each argument is as follows:
   *        bind: two-way binding where remote changes are reflected locally and vice-versa.
   *        pull: one-way binding where remote changes are reflected locally and local changes get
   *            overwritten.
   *        once: one-way binding that grabs the remote value once then disconnects, but if the path
   *            interpolation changes it will grab the value at the new path once too.
   *        noop: no binding, just creates a handle that can be used to get a reference.
   *    via, viaKeys, viaValues, viaIds:  A Firebase path used for indirection, to find the keys of
   *        the primary path that should be bound; at most one of these arguments can be specified.
   *        When a via* connection is requested, the connection must be of 'bind' or 'pull' type,
   *        and the primary path must contain a '#' symbol to indicate where the selected keys
   *        should be substituted; this is typically at the end of the path, but doesn't have to be.
   *        The meaning of each argument is as follows:
   *        via: the via path is expected to point to a single string value, which is used as the
   *            key in the primary path, and the resulting fetched value stored directly in
   *            scope[name].
   *        viaKeys: the via path is expected to point to an object, whose keys are used as the key
   *            in the primary path.  The resulting fetched values are stored in scope[name][key]
   *            for each key.
   *        viaValues: the via path is expected to point to an object, whose values are used as the
   *            key in the primary path.  The resulting fetched values are stored in
   *            scope[name][key] for each key.
   *        viaIds: not actually a path, but rather an array of ids to use directly.  The array must
   *            be constant as it is not watched for changes.
   *    viaValueExtractor:  A function that extracts the desired primary key from a value.  Can only
   *        be used when viaValues is specified.  Normally used when the collection of objects used
   *        for indirection holds the desired pointer in a nested attribute.
   *    query:  A function that, given a Firebase reference, applies any desired query limit to it.
   *        This will be invoked automatically on either the primary reference, or on the via*
   *        reference, as appropriate.
   *    watch:  An array of watcher declarations, for reacting to changes in the connected value or
   *        its children.  These watchers are similar to Angular's $scope.$watch* methods but much
   *        more efficient because they only work on Firebase data.  For extra efficiency, consider
   *        debouncing or throttling the callback functions if they're hooked into paths that update
   *        nearly but not exactly at the same time.  For now, watchers are only compatible with
   *        single-valued connections (plain or via).  Each watcher declaration looks like this:
   *        child: optional path to the child of interest, relative to the connection's path and to
   *            be interpolated using the same scope.
   *        onChange: optional function to be invoked whenever the value pointed to by the child
   *            path (or the connection itself) changes, at any depth.  The function is not passed
   *            any arguments -- if you want the new value, you can get it from the bound scope.
   *        onCollectionChange: optional function to be invoked whenever the object pointed to by
   *            the child path (or the connection itself) has children added, removed, or moved (by
   *            changing their priority).  The function is passed three array arguments: a list of
   *            keys added since the last call, removed since the last call, and moved since the
   *            last call.
   *    digest:  A function that will be called after each time changes from Firebase are applied to
   *        a local model.  Defaults to $rootScope.$evalAsync, but in some cases it can be useful to
   *        override it with a throttled or debounced wrapper around $evalAsync instead.  Does not
   *        affect watchers.
   *    onError:  A function that will be called whenever any Firebase call fails, either in the
   *        main connection or in a watch.  Errors come mainly from on() listeners, but can also be
   *        from mutation methods in a 'bind' connection.  The function will be passed the error
   *        object given by Firebase, and its return value will be returned from the original
   *        callback as well.
   * @return {Object} A handle to the connection with the following methods:
   *    destroy(keepValue):  Destroys this connection (including all listeners), and deletes the
   *        destination attribute unless keepValue is true.
   *    isReady():  Returns whether the connection has processed the initial remote value.
   *    ready():  Returns a promise that will be resolved (with no value) when the connection
   *        becomes ready.
   *    ref(...) or viaRef, viaKeysRef, viaValuesRef:  Returns a Firebase reference to the data
   *        path.  If the connection is of via* type then a reference to the via path is returned
   *        instead (using the appropriate method variant), and the main reference cannot be
   *        obtained (as there are in fact many of them for viaKeys and viaValues connections).  If
   *        any extra arguments are specified they are treated as a child path and suffixed to the
   *        reference before it is returned.
   *    via, viaKeys, viaValues:  If the connection is of via* type, the corresponding method
   *        returns the current value selected by the via* path.
   *    allowedKeys():  For viaKeys and viaValues connections, returns an object that has all the
   *        keys that have been selected by the via* clause and will be dereferenced into the
   *        attribute (even if the dereferencing fails).
   */
  self.connectOne = function(args) {
    if (!args.name) {
      throw new Error('Must provide a name for the connection.');
    }
    if (('bind' in args) + ('pull' in args) + ('once' in args) + ('noop' in args) !== 1) {
      throw new Error(
        'Each connection must specify exactly one of "bind", "pull", "once" and "noop".');
    }
    var connectionFlavor, path;
    angular.forEach(['bind', 'pull', 'once', 'noop'], function(flavor) {
      if (flavor in args) {
        connectionFlavor = flavor;
        path = args[flavor];
      }
    });
    var refName = 'ref', viaFlavor, viaPath;
    angular.forEach(['via', 'viaKeys', 'viaValues', 'viaIds'], function(flavor) {
      if (flavor in args) {
        if (viaFlavor) {
          throw new Error(
            'A connection can specify at most one of "via", "viaKeys", "viaValues", and "viaIds".');
        }
        viaFlavor = flavor;
        if (flavor === 'viaIds') {
          refName = null;
        } else {
          viaPath = args[flavor];
          refName = flavor + 'Ref';
        }
      }
    });
    if (viaFlavor && (connectionFlavor === 'once' || connectionFlavor === 'noop')) {
      throw new Error('Cannot combine "' + viaFlavor + '" with "once" or "noop".');
    }
    // Warning: can't just check args.watch here because Firefox defines Object.prototype.watch as
    // a non-standard function!
    if (args.hasOwnProperty('watch') && viaFlavor && viaFlavor !== 'via') {
      throw new Error('Cannot yet combine "' + viaFlavor + '" with "watch".');
    }
    if (args.viaValueExtractor && viaFlavor !== 'viaValues') {
      throw new Error('Can only use "viaValueExtractor" with "viaValues".');
    }
    if (viaFlavor === 'viaIds' && args.query) {
      throw new Error('Cannot combine "viaIds" with "query".');
    }
    args.digest = args.digest || _.bind($rootScope.$evalAsync, $rootScope);

    var watchers = [];
    angular.forEach(args.watch, function(watch) {
      watchers.push(new Watcher(watch, args.pathScope || args.scope, args.digest, args.onError));
    });

    function notifyWatchers(ref) {
      angular.forEach(watchers, function(watcher) {watcher.updateParentRef(ref);});
    }

    function applyQuery(ref) {
      if (args.query) ref = args.query(ref);
      return ref;
    }

    var fire, fireDeferred = $q.defer();
    expandPath(args.pathScope || args.scope, path, viaPath, function(iPath, iViaPath) {
      if (fire) {
        fire.destroy();
        fire = null;
      }
      if (connectionFlavor === 'noop' && iPath) {
        fire = {
          destroy: angular.noop,
          isReady: true,
          ready: function() {return $q.when();},
        };
        // TODO: support via*
        fire[refName] = applyQuery(new Firebase(iPath));
        notifyWatchers(fire.ref());
      } else if (connectionFlavor === 'once' && iPath) {
        var readyDeferred = $q.defer();
        var myFire = fire = {
          destroy: angular.noop,
          isReady: false,
          ready: function() {return readyDeferred.promise;},
        };
        // TODO: support via*
        fire[refName] = applyQuery(new Firebase(iPath));
        notifyWatchers(fire.ref());
        fire[refName].once('value', function(snap) {
          if (fire !== myFire) return;  // path binding changed while we were getting the value
          args.scope[args.name] = normalizeSnapshotValue(snap);
          fire.isReady = true;
          readyDeferred.resolve();
          args.digest();
        }, args.onError);
      } else if (iPath && (!viaPath || iViaPath)) {
        if (iViaPath) {
          fire = Fire(
            args.scope, args.name, connectionFlavor, iPath, viaFlavor,
            applyQuery(new Firebase(iViaPath)), args.viaValueExtractor, args.digest, args.onError,
            notifyWatchers);
        } else if (viaFlavor === 'viaIds') {
          fire = Fire(
            args.scope, args.name, connectionFlavor, iPath, viaFlavor, args.viaIds, null,
            args.digest, args.onError, notifyWatchers);
        } else {
          fire = Fire(
            args.scope, args.name, connectionFlavor, applyQuery(new Firebase(iPath)), null, null,
            null, args.digest, args.onError, notifyWatchers);
        }
      }
      if (fire) fireDeferred.resolve(fire);
    });

    var handle = {
      destroy: function(keepValue) {
        if (fire) fire.destroy(keepValue);
        angular.forEach(watchers, function(watcher) {watcher.destroy();});
      },
      isReady: function() {return fire && fire.isReady;},
      ready: function() {return fireDeferred.promise.then(function(fire) {return fire.ready();});},
      allowedKeys: function() {return fire && fire.allowedKeys;}
    };
    if (args.scope.$on) args.scope.$on('$destroy', handle.destroy);

    if (refName) {
      handle[refName] = function() {
        var ref = fire && fire[refName];
        if (ref) {
          if (ref.ref) ref = ref.ref();
          if (arguments.length) ref = ref.child(Array.prototype.slice.call(arguments, 0).join('/'));
        }
        return ref;
      };
    }
    if (viaFlavor === 'via') {
      handle.ref = function() {
        var ref = fire && fire.ref;
        if (ref) {
          if (ref.ref) ref = ref.ref();
          if (arguments.length) ref = ref.child(Array.prototype.slice.call(arguments, 0).join('/'));
        }
        return ref;
      };
    }
    if (viaFlavor) {
      handle[viaFlavor] = function() {return fire && fire.filterValue;};
    }

    return handle;
  };

  /**
   * Connects multiple attributes to values in the Firebase datastore.  Works just like connectOne
   * except that the same scope is specified for all the connections, and the name of each
   * connection is its key in the map.
   * @param  {Object} scope The scope to bind values into; either an Angular scope or any other
   *    object, but if it's an object you'll have to destroy the connections yourself.
   * @param  {Object} map The map of attribute names to their connection options.
   * @return {Object} A map of the connection handles (like those from connectOne), with one handle
   *    per item in the input map.  Also has two extra methods:
   *    $allReady():  Returns a promise that resolves when all requested connections have been made
   *        ready.  The resolve value will be a map of connection name to the bound value at the
   *        moment the promise is resolved (particularly useful for 'once' connections).
   *    $destroyAll(keepValue):  Calls destroy(keepValue) on all the connections in the map.
   */
  self.connect = function(scope, map) {
    var handles = {};
    angular.forEach(map, function(args, name) {
      args.scope = scope;
      args.name = name;
      handles[name] = self.connectOne(args);
    });
    handles.$allReady = function() {
      var boundNames = [], promises = [];
      angular.forEach(handles, function(value, key) {
        if (key.charAt(0) === '$') return;
        boundNames.push(key);
        promises.push(value.ready());
      });
      return $q.all(promises).then(function() {
        var values = {};
        angular.forEach(boundNames, function(name) {
          values[name] = scope[name];
        });
        return values;
      });
    };
    handles.$areAllReady = function() {
      var ready = true;
      angular.forEach(handles, function(value, key) {
        if (key.charAt(0) === '$') return;
        ready = ready && value.isReady();
      });
      return ready;
    };
    handles.$destroyAll = function(keepValue) {
      angular.forEach(handles, function(value, key) {
        if (key.charAt(0) !== '$') value.destroy(keepValue);
      });
    };
    return handles;
  };

  /**
   * Converts a Firebase object to an array of its values, sorted by the values' keys.  Adds a $key
   * property to each object as a side-effect.
   * @param  {Object} o The Firebase object to convert; can be empty, null, or undefined.
   * @return {Array} An array containing all the values from the given object.
   */
  self.toArrayOrderedByKey = function(o) {
    var array = [];
    if (o) {
      angular.forEach(o, function(value, key) {
        if (angular.isObject(value)) array.push(value);
      });
      orderByFilter(array, '$key');
    }
    return array;
  };

  /**
   * Generates a new, globally unique key in the same way as push() does.
   * @return {string} A unique key.
   */
  self.generateUniqueKey = function() {
    return new Firebase(root).push().key();
  };

  function Watcher(watch, scope, digest, onError) {
    this.digest = digest;
    this.onChange = watch.onChange;
    this.onCollectionChange = watch.onCollectionChange;
    this.onError = onError;
    this.change = false;
    this.addedKeys = [];
    this.removedKeys = [];
    this.movedKeys = [];
    this.allKeys = [];

    if (watch.child) {
      var childInterpolator = watch.child && $interpolate(watch.child, true);
      if (childInterpolator) {
        if (scope.$watch) {
          scope.$watch(childInterpolator, angular.bind(this, function(childPath) {
            if (childPath.indexOf('//') !== -1 || childPath.charAt(childPath.length - 1) === '/' ||
                childPath.charAt(0) === '/') {
              this.childPath = null;
            } else {
              this.childPath = childPath;
            }
            this.updateRef();
          }));
        } else {
          this.childPath = childInterpolator(scope);
        }
      } else {
        this.childPath = watch.child;
      }
    }
  }

  Watcher.prototype.updateParentRef = function(ref) {
    this.parentPath = ref && ref.toString() || null;
    this.updateRef();
  };

  Watcher.prototype.updateRef = function() {
    var path;
    if (this.childPath === null || this.parentPath === null) {
      path = null;
    } else {
      path = this.parentPath;
      if (this.childPath) path += '/' + this.childPath;
    }
    if (path ? this.ref && this.ref.toString() === path : !this.ref) return;
    if (this.ref) this.unlisten();
    this.ref = path ? new Firebase(path) : null;
    this.change = true;
    this.addedKeys = [];
    this.movedKeys = [];
    this.removedKeys = this.allKeys;
    this.allKeys = [];
    if (this.ref) {
      this.listen();  // value event will come in and fire changes
    } else {
      this.fireChangesAsync();
    }
  };

  Watcher.prototype.listen = function() {
    if (this.onChange) {
      this.refOn('value', this.valueChanged);
    }
    if (this.onCollectionChange) {
      this.refOn('child_added', this.childAdded);
      this.refOn('child_removed', this.childRemoved);
      this.refOn('child_moved', this.childMoved);
    }
  };

  Watcher.prototype.refOn = function(eventType, callback) {
    if (this.onError) this.ref.on(eventType, callback, this.onError, this);
    else this.ref.on(eventType, callback, this);
  };

  Watcher.prototype.unlisten = function() {
    if (this.onChange) {
      this.ref.off('value', this.valueChanged, this);
    }
    if (this.onCollectionChange) {
      this.ref.off('child_added', this.childAdded, this);
      this.ref.off('child_removed', this.childRemoved, this);
      this.ref.off('child_moved', this.childMoved, this);
    }
  };

  Watcher.prototype.destroy = function() {
    if (this.ref) this.unlisten();
  };

  Watcher.prototype.valueChanged = function() {
    this.change = true;
    this.fireChangesAsync();
  };

  Watcher.prototype.childAdded = function(snap) {
    this.addedKeys.push(snap.key());
    var k = this.removedKeys.indexOf(snap.key());
    if (k >= 0) this.removedKeys.splice(k, 1);
    this.fireChangesAsync();
  };

  Watcher.prototype.childRemoved = function(snap) {
    this.removedKeys.push(snap.key());
    var k = this.addedKeys.indexOf(snap.key());
    if (k >= 0) this.addedKeys.splice(k, 1);
    k = this.movedKeys.indexOf(snap.key());
    if (k >= 0) this.movedKeys.splice(k, 1);
    k = this.allKeys.indexOf(snap.key());
    if (k >= 0) this.allKeys.splice(k, 1);
    this.fireChangesAsync();
  };

  Watcher.prototype.childMoved = function(snap) {
    this.movedKeys.push(snap.key());
    this.fireChangesAsync();
  };

  Watcher.prototype.fireChangesAsync = function() {
    $timeout(angular.bind(this, function() {
      this.fireChanges();
      this.digest();
    }), 0, false);
  };

  Watcher.prototype.fireChanges = function fireWatcherChanges() {
    if (this.onChange && this.change) {
      this.change = false;
      this.onChange();
    }
    if (this.onCollectionChange && (
        this.addedKeys.length || this.removedKeys.length || this.movedKeys.length)) {
      var addedKeys = this.addedKeys, removedKeys = this.removedKeys, movedKeys = this.movedKeys;
      this.allKeys.push.apply(this.allKeys, addedKeys);
      angular.forEach(removedKeys, function(key) {
        var k = this.allKeys.indexOf(key);
        if (k >= 0) this.allKeys.splice(k, 1);
      }, this);
      this.addedKeys = []; this.removedKeys = []; this.movedKeys = [];
      this.onCollectionChange(addedKeys, removedKeys, movedKeys);
    }
  };

  return self;

  function Fire(
      scope, name, connectionFlavor, ref, filterFlavor, filterRef, filterValueExtractor, digest,
      onError, onRefChange) {
    var self = {};
    var listeners = {};
    filterValueExtractor = filterValueExtractor || angular.identity;

    //Resolved once initial value comes down
    var readyDeferred = $q.defer();

    self.destroy = destroy;
    self.isReady = false;
    self.ready = function() {
      return readyDeferred.promise;
    };

    if (filterRef) {
      self.allowedKeys = {};
      var filterPath = ref;
      ref = null;
      setupFilterRef();
      self[filterFlavor + 'Ref'] = filterRef;
    } else {
      //No filterRef? listen to the root
      firebaseBindRef([], onRootValue);
      self.ref = ref;
      if (onRefChange) onRefChange(self.ref);
    }

    var reporter, unbindWatch;
    if (connectionFlavor === 'bind') {
      reporter = fireHelpers.makeObjectReporter(scope, name, onLocalChange);
      unbindWatch = $rootScope.$watch(reporter.compare, angular.noop);
    }

    return self;

    function destroy(keepValue) {
      angular.forEach(listeners, function(submap, targetName) {
        removeListeners(new Firebase(targetName));
      });
      if (filterFlavor === 'viaKeys' || filterFlavor === 'viaValues') {
        angular.forEach(scope[name], function(value, key) {
          firebaseUnbindRef([key], value);
        });
      } else if (ref) {
        firebaseUnbindRef([], scope[name]);
      }
      if (unbindWatch) unbindWatch();
      if (reporter) reporter.destroy();
      if (!keepValue) delete scope[name];
    }

    function addListener(target, event, callback) {
      var targetName = target.toString();
      if (!listeners[targetName]) listeners[targetName] = {};
      if (!listeners[targetName][event]) listeners[targetName][event] = [];
      listeners[targetName][event].push(callback);
      target.on(event, callback, onError);
    }

    function removeListeners(target) {
      var events = listeners[target.toString()];
      if (events) {
        angular.forEach(events, function(callbacks, event) {
          angular.forEach(callbacks, function(callback) {
            target.off(event, callback);
          });
        });
      }
      delete listeners[target.toString()];
    }

    function setupFilterRef() {
      if (filterFlavor === 'via') {
        addListener(filterRef, 'value', function(snap) {
          if (ref) {
            firebaseUnbindRef([], scope[name]);
            delete scope[name];
          }
          if (snap.hasChildren()) {
            throw new Error(
              'via value of ' + filterRef + ' must not be an object, ignoring: ' + snap.val());
          }
          self.filterValue = snap.val();  // it's primitive
          self.ref = ref = new Firebase(filterPath.replace('#', self.filterValue));
          firebaseBindRef([], onRootValue);
          if (onRefChange) onRefChange(self.ref);
        });
      } else if (filterFlavor === 'viaKeys' || filterFlavor === 'viaValues') {
        scope[name] = scope[name] || {};
        addListener(filterRef, 'value', function(snap) {
          self.filterValue = normalizeSnapshotValue(snap);
          if (self.filterValue) {
            angular.forEach(self.filterValue, function(value, key) {
              if (key.charAt(0) !== '$') {
                setWhitelistedKey(
                  filterFlavor === 'viaKeys' ? key : filterValueExtractor(value), true);
              }
            });
          } else {
            // If the filter ref has no keys in it, then we have no keys allowed, and just set ready
            // to true.
            setReady();
          }
        });
        addListener(filterRef, 'child_removed', function(snap) {
          setWhitelistedKey(snap.key(), false);
        });
      } else if (filterFlavor === 'viaIds') {
        scope[name] = scope[name] || {};
        self.filterValue = filterRef;
        if (filterRef.length) {
          for (var i = 0; i < filterRef.length; i++) {
            setWhitelistedKey(filterRef[i], true);
          }
        } else {
          setReady();
        }
      }
    }

    function onLocalChange(path, newValue) {
      if (!self.isReady && !angular.isObject(newValue) || angular.isUndefined(newValue)) {
        // will get merged in when remote value first comes in
        return;
      }

      var childRef = getRefFromPath(path);
      newValue = fireHelpers.fireCopy(newValue);

      // Update objects instead of just setting (not sure why, angularFire does this so we do too)
      if (angular.isObject(newValue) && !angular.isArray(newValue)) {
        childRef.update(newValue, function(error) {if (error && onError) return onError(error);});
      } else {
        childRef.set(newValue, function(error) {if (error && onError) return onError(error);});
      }
    }

    function setWhitelistedKey(key, isAllowed) {
      if (!key || !!self.allowedKeys[key] === isAllowed) return;
      if (isAllowed) {
        self.allowedKeys[key] = true;
        firebaseBindRef([key], onFilteredPropValue(key));
      } else {
        var value = scope[name] && scope[name][key];
        invokeChange('child_removed', [], key);
        firebaseUnbindRef([key], value);
        delete self.allowedKeys[key];
      }
    }

    //listen to value on the top-level, if we have a primitive at the root
    //Three cases in which we need to reassign the top level:
    //1) if top level is a primitive (eg  1 to 2 or string to string)
    //2) if top level was a primitive and now we are to object, reassign
    //3) if top level was object and now we are to primitive, reassign
    function onRootValue(value) {
      if (!self.isReady) {
        //First time value comes, merge it in and push it
        scope[name] = fireHelpers.fireMerge(value, scope[name]);
        setReady();
        if (connectionFlavor === 'bind') {
          self.ready().then(function() {
             onLocalChange([], scope[name]);
          });
        }
      } else if (!angular.isObject(value) || !angular.isObject(scope[name])) {
        scope[name] = value;
        if (reporter) reporter.savedScope[name] = angular.copy(value);
      }
      digest();
    }

    //listen to value for each filtered key. same rules as top level,
    //except we're one key down
    function onFilteredPropValue(key) {
      return function onValue(value) {
        if (!angular.isObject(value) || !angular.isObject(scope[name] && scope[name][key])) {
          if (angular.isUndefined(scope[name])) {
            // We got destroyed while waiting for the callback, ignore.
            return;
          }
          scope[name][key] = value;
          if (reporter) reporter.savedScope[name][key] = angular.copy(value);
          if (!self.isReady && Object.keys(self.allowedKeys).every(function(key) {
            return scope[name].hasOwnProperty(key);
          })) {
            setReady();
          }
          // Trigger just one digest after all filtered props have been initialized.  Afterwards,
          // trigger one digest per change as normal.
          if (self.isReady) digest();
        }
      };
    }

    function setReady() {
      if (!self.isReady) {
        self.isReady = true;
        readyDeferred.resolve();
        digest();
      }
    }

    function getRefFromPath(path) {
      var pathRef;
      if (filterPath && filterFlavor !== 'via') {
        pathRef = new Firebase(filterPath.replace('#', path[0]));
        if (path.length > 1) pathRef = pathRef.child(path.slice(1).join('/'));
      } else {
        pathRef = path.length ? (ref.ref ? ref.ref() : ref).child(path.join('/')) : ref;
      }
      return pathRef;
    }

    function firebaseBindRef(path, onValue) {
      path = path || [];
      var watchRef = getRefFromPath(path);

      addListener(watchRef, 'child_added', function(snap) {
        var value = normalizeSnapshotValue(snap);
        // For objects, watch each child.
        if (snap.hasChildren()) firebaseBindRef(path.concat(snap.key()));
        invokeChange('child_added', path, snap.key(), value);
      });

      addListener(watchRef, 'child_removed', function(snap) {
        firebaseUnbindRef(path.concat(snap.key()), normalizeSnapshotValue(snap));
        invokeChange('child_removed', path, snap.key());
      });

      addListener(watchRef, 'child_changed', function(snap) {
        // Only call changes at the leaves, otherwise ignore.  Use raw snap.val() here because the
        // value is guaranteed to be primitive or null.
        if (!snap.hasChildren()) invokeChange('child_changed', path, snap.key(), snap.val());
      });

      if (onValue) {
        addListener(watchRef, 'value', function(snap) {
          onValue(normalizeSnapshotValue(snap));
        });
      }
    }

    function firebaseUnbindRef(path, value) {
      path = path || [];
      var childRef = getRefFromPath(path);
      // Unbind this ref, then if the value removed is an object, unbind anything watching
      // all of the object's child key/value pairs.
      // Eg if we remove an object { a: 1, b: { c: { d: 'e' } } }, it should call .off()
      // on the parent, a/b, a/b, and a/b/c
      if (angular.isObject(value)) {
        angular.forEach(value, function(childValue, childKey) {
          if (!angular.isString(childKey) || childKey.charAt(0) !== '$') {
            firebaseUnbindRef(path.concat(childKey), childValue);
          }
        });
      }
      removeListeners(childRef);
    }

    function invokeChange(type, path, key, value) {
      var parsed = fireHelpers.parsePath(name, path);
      switch(type) {
        case 'child_removed':
          fireHelpers.remove(parsed(scope), key, value);
          if (reporter) fireHelpers.remove(parsed(reporter.savedScope), key);
          break;
        case 'child_added':
        case 'child_changed':
          fireHelpers.set(parsed(scope), key, value);
          if (reporter) fireHelpers.set(parsed(reporter.savedScope), key, angular.copy(value));
      }
      digest();
    }
  }
}];

})


.filter('escapeFirebase', function() {
  'use strict';
  return function(name) {
    return name.toString().replace(/[\\\.\$\#\[\]\/]/g, function(char) {
      return '\\' + char.charCodeAt(0).toString(16);
    });
  };
})


.factory('fireHelpers', [function() {
  'use strict';
  var self = {};

  var FIRE_COMPARE_MAX_DEPTH = 6;

  self.remove = function(scope, key) {
    if (angular.isArray(scope)) {
      scope.splice(key, 1);
    }  else if (scope) {
      delete scope[key];
    }
  };

  self.set = function(scope, key, value) {
    if (scope) scope[key] = value;
  };

  self.parsePath = function(name, path) {
    return function(scope) {
      var value = scope[name];
      for (var i = 0, ii = path.length; i < ii; i++) {
        if (value === null || angular.isUndefined(value)) return;
        value = value[path[i]];
      }
      return value;
    };
  };

  // fireCopy: copy a value and remove $-prefixed attrs
  self.fireCopy = function(value) {
    // Do nothing for arrays and primitives
    if (angular.isObject(value)) {
      var cloned = angular.isArray(value) ? new Array(value.length) : {};
      for (var key in value) {
        if (value.hasOwnProperty(key) && key.charAt(0) !== '$' && angular.isDefined(value[key])) {
          if (angular.isObject(value[key])) {
            cloned[key] = self.fireCopy(value[key]);
          } else {
            cloned[key] = value[key];
          }
        }
      }
      return cloned;
    }
    return value;
  };

  self.fireMerge = function(remote, local) {
    var merged;
    if (angular.equals(remote, local)) {
      return local;
    } else if (angular.isArray(remote) && angular.isArray(local)) {
      return local.concat(remote);
    } else if (angular.isObject(remote) && angular.isObject(local)) {
      merged = local;
      for (var key in remote) {
        merged[key] = remote[key];
      }
      return merged;
    } else if ((angular.isUndefined(remote) || remote === null) && angular.isDefined(local)) {
      return local;
    } else {
      //Eg if remote is a primitive this will fire
      return remote;
    }
  };

  self.makeObjectReporter = function(object, name, callback) {
    var savedScope = {};
    savedScope[name] = angular.copy(object[name]);

    function compareFn() {
      compare(savedScope, object, name, [], FIRE_COMPARE_MAX_DEPTH);
    }
    function destroy() {
      if (savedScope) delete savedScope[name];
      savedScope = null;
    }

    return {
      savedScope: savedScope,
      compare: compareFn,
      destroy: destroy,
    };

    function reportChange(path, newValue) {
      if (angular.isUndefined(newValue)) newValue = null;
      path.shift(); // first item in path is the `name`, we don't need this
      callback(path, newValue);
    }

    function compare(oldObject, newObject, key, path, depth) {
      if (key.charAt && key.charAt(0) === '$') {
        return;
      }
      depth--;
      if (!depth) {
        if ( !angular.equals(oldObject[key], newObject[key]) ) {
          oldObject[key] = angular.copy(newObject[key]);
          return reportChange(path.concat(key), newObject[key]);
        }
      }


      var newValue = newObject[key];
      var oldValue = oldObject[key];
      var childKey;

      if (!angular.isObject(newValue)) {
        if (newValue !== oldValue) {
          oldObject[key] = newValue;
          reportChange(path.concat(key), newValue);
        }
      } else if (angular.isArray(newValue)) {
        if (!angular.isArray(oldValue)) {
          //if new value is array and old wasn't, just copy the whole array and update
          reportChange(path.concat(key), newValue);
          oldObject[key] = oldValue = newValue.slice();
        }

        //If old array is bigger, report deletion
        var i, ii;
        if (oldValue.length > newValue.length) {
          for (i=newValue.length,ii=oldValue.length; i<ii; i++) {
            reportChange(path.concat(key, i), null);
          }
        }
        oldValue.length = newValue.length;
        //copy the items to oldValue and look for changes
        for (i=0, ii=newValue.length; i<ii; i++) {
          compare(oldValue, newValue, i, path.concat(key), depth);
        }
      } else {
        if (!angular.isObject(oldValue) || angular.isArray(oldValue)) {
          //if new value is object and old wasn't, just copy the whole object and update
          reportChange(path.concat(key), newValue);
          oldObject[key] = oldValue = angular.copy(newValue);
        }
        //Copy newValue to oldValue and look for changes
        for (childKey in newValue) {
          if (newValue.hasOwnProperty(childKey) ) {
            compare(oldValue, newValue, childKey, path.concat(key), depth);
          }
        }
        for (childKey in oldValue) {
          if (!newValue.hasOwnProperty(childKey)) {
            delete oldValue[childKey];
            reportChange(path.concat(key, childKey), null);
          }
        }
      }
    }
  };

  return self;
}]);
