angular.module('altfire', [])

/**
 * The main Firebase/Angular adapter service.
 */
.factory('fire', ['$interpolate', '$q', '$parse', '$timeout', 'orderByFilter',
    function($interpolate, $q, $parse, $timeout, orderByFilter) {
  var self = {};
  var root = null;
  var pathCache = {};
  var pathCacheMaxSize = 5000;

  /**
   * Sets the default root for all Firebase data paths that don't include a host. You probably
   * want to set a root when your app initializes. Note that no distinction is made between
   * relative and absolute paths -- all have the full root prepended if they lack a host.
   * @param {string} rootUrl The root URL, usually something like 'https://foo.firebaseio.com' but
   * can also include a path component.
   */
  self.setDefaultRoot = function(rootUrl) {
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
    pathCache = {};
  };

  function prefixRoot(path, noWatch) {
    if (path in pathCache) return pathCache[path];
    // Simple eviction policy: if cache gets too large, wipe it and start from scratch.
    if (Object.keys(pathCache).length >= pathCacheMaxSize) pathCache = {};
    if (angular.isString(path)) {
      var isFullPath = path.slice(0, 8) === 'https://';
      if (path && ((isFullPath ? path.slice(8) : path).indexOf('//') !== -1 ||
          path.charAt(path.length - 1) === '/' || path.charAt(0) === '/')) {
        try {
          throw new Error('Invalid path interpolation: ' + path);
        } catch(e) {
          if (noWatch) throw e;
          console.debug(e.stack.replace(/\n[^\n]*(altfire|angular(\.min)?)\.js[^\n]*$/gm, ''));
        }
        pathCache[path] = null;
        return null;
      }
      if (!isFullPath) {
        if (!root) {
          throw new Error('Relative path given and default root not specified.');
        }
        path = pathCache[path] = root + path;
      }
    }
    return path;
  }

  function expandPath(scope, path, viaPath, callback, noWatch) {
    if (!scope.$watch) noWatch = true;
    if (viaPath && path.search('#') === -1) {
      path += '/#';
    }
    var pathInterpolator = angular.isString(path) ? $interpolate(path, false) : undefined;
    var viaPathInterpolator = angular.isString(viaPath) ? $interpolate(viaPath, false) : undefined;

    function interpolatePaths(scope) {
      return [
        prefixRoot(pathInterpolator ? pathInterpolator(scope) : path, noWatch),
        prefixRoot(viaPathInterpolator ? viaPathInterpolator(scope) : viaPath, noWatch),
      ];
    }

    if (!noWatch && scope.$watch) {
      scope.$watch(interpolatePaths, function(paths, oldPaths) {
        if (paths !== oldPaths) callback.apply(null, paths);
      }, true);
    }
    // Even if watching, issue the first callback synchronously so the handle will be valid
    // immediately.
    callback.apply(null, interpolatePaths(scope));
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
   * @return {Object} A handle to the connection with the following methods:
   *    destroy():  Destroys this connection (including all listeners) and deletes the destination
   *        attribute.
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
      throw new Error('Cannot combine via* with "once" or "noop".');
    }
    if (args.viaValueExtractor && viaFlavor !== 'viaValues') {
      throw new Error('Can only use "viaValueExtractor" with "viaValues".');
    }
    if (viaFlavor === 'viaIds' && args.query) {
      throw new Error('Cannot combine viaIds with a query.');
    }

    function applyQuery(ref) {
      if (args.query) ref = args.query(ref);
      return ref;
    }

    var fire;
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
        fire[refName] = applyQuery(new Firebase(iPath));
      } else if (connectionFlavor === 'once' && iPath) {
        var readyDeferred = $q.defer();
        var myFire = fire = {
          destroy: angular.noop,
          isReady: false,
          ready: function() {return readyDeferred.promise;},
        };
        fire[refName] = applyQuery(new Firebase(iPath));
        fire[refName].once('value', function(snap) {
          if (fire !== myFire) return;  // path binding changed while we were getting the value
          args.scope[args.name] = snap.val();
          fire.isReady = true;
          readyDeferred.resolve();
        });
      } else if (iPath && (!viaPath || iViaPath)) {
        if (iViaPath) {
          fire = Fire(
            args.scope, args.name, connectionFlavor, iPath, viaFlavor,
            applyQuery(new Firebase(iViaPath)), args.viaValueExtractor);
        } else if (viaFlavor === 'viaIds') {
          fire = Fire(args.scope, args.name, connectionFlavor, iPath, viaFlavor, args.viaIds);
        } else {
          fire = Fire(args.scope, args.name, connectionFlavor, applyQuery(new Firebase(iPath)));
        }
      }
    });
    var handle = {
      destroy: function() {if (fire) fire.destroy();},
      isReady: function() {return fire && fire.isReady;},
      ready: function() {return fire && fire.ready();},
      allowedKeys: function() {return fire && fire.allowedKeys;}
    };
    if (refName) {
      handle[refName] = function() {
        var ref = fire[refName];
        if (ref.ref) ref = ref.ref();
        if (arguments.length) ref = ref.child(Array.prototype.slice.call(arguments, 0).join('/'));
        return ref;
      };
    }
    if (viaFlavor) {
      handle[viaFlavor] = function() {return fire.filterValue;};
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
   *    $destroyAll():  Calls destroy() on all the connections in the map.
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
        if (value.ready()) promises.push(value.ready());
      });
      return $q.all(promises).then(function() {
        var values = {};
        angular.forEach(boundNames, function(name) {
          values[name] = scope[name];
        });
        return values;
      });
    };
    handles.$destroyAll = function() {
      angular.forEach(handles, function(value, key) {
        if (key.charAt(0) !== '$') value.destroy();
      });
    };
    return handles;
  };

  /**
   * Converts a Firebase object to an array of its values, sorted by the values' keys.
   * @param  {Object} o The Firebase object to convert; can be empty, null, or undefined.
   * @return {Array} An array containing all the values from the given object.  Each of the values
   *    is also augmented with a '$key' attribute that holds its original key.
   */
  self.toArrayOrderedByKey = function(o) {
    var array = [];
    if (o) {
      angular.forEach(o, function(value, key) {
        if (angular.isObject(value)) {
          value.$key = key;
          array.push(value);
        }
      });
      orderByFilter(array, '$key');
    }
    return array;
  };

  return self;

  function Fire(scope, name, connectionFlavor, ref, filterFlavor, filterRef, filterValueExtractor) {
    var self = {};
    var listeners = {};
    filterValueExtractor = filterValueExtractor || angular.identity;

    //Resolved once initial value comes down
    var readyDeferred = $q.defer();

    if (scope.$on) scope.$on('$destroy', destroy);
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
    }

    var reporter, unbindWatch;
    if (connectionFlavor === 'bind') {
      if (!scope.$watch) {
        throw new Error('Can only bind to Angular scopes.');
      }
      reporter = makeObjectReporter(scope, name, onLocalChange);
      unbindWatch = scope.$watch(reporter.compare, angular.noop);
    }

    return self;

    function destroy() {
      if (filterRef) {
        removeListeners(filterRef);
        self.allowedKeys = {};
      }
      if (filterFlavor === 'viaKeys' || filterFlavor === 'viaValues') {
        angular.forEach(scope[name], function(value, key) {
          firebaseUnbindRef([key], value);
        });
      } else if (ref) {
        firebaseUnbindRef([], scope[name]);
      }
      if (unbindWatch) unbindWatch();
      if (reporter) reporter.destroy();
      delete scope[name];
    }

    function addListener(target, event, callback) {
      var targetName = target.toString();
      if (!listeners[targetName]) listeners[targetName] = {};
      if (!listeners[targetName][event]) listeners[targetName][event] = [];
      listeners[targetName][event].push(callback);
      target.on(event, callback);
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
          self.filterValue = snap.val();
          ref = new Firebase(filterPath.replace('#', snap.val()));
          firebaseBindRef([], onRootValue);
        });
      } else if (filterFlavor === 'viaKeys' || filterFlavor === 'viaValues') {
        scope[name] = scope[name] || {};
        addListener(filterRef, 'value', function(snap) {
          self.filterValue = snap.val();
          if (self.filterValue) {
            angular.forEach(self.filterValue, function(value, key) {
              setWhitelistedKey(
                filterFlavor === 'viaKeys' ? key : filterValueExtractor(value), true);
            });
          } else {
            // If the filter ref has no keys in it, then we have no keys allowed, and just set ready
            // to true.
            setReady();
          }
        });
        addListener(filterRef, 'child_removed', function(snap) {
          setWhitelistedKey(snap.name(), false);
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
      newValue = fireCopy(newValue);

      // Update objects instead of just setting (not sure why, angularFire does this so we do too)
      if (angular.isObject(newValue) && !angular.isArray(newValue)) {
        childRef.update(newValue, callback);
      } else {
        childRef.set(newValue, callback);
      }
      function callback(error) {
        if (error) $rootScope.$emit('fire:error', self, {
          path: path,
          value: newValue,
          error: error
        });
      }
    }

    function setWhitelistedKey(key, isAllowed) {
      if (!key || !!self.allowedKeys[key] === isAllowed) return;
      if (isAllowed) {
        self.allowedKeys[key] = true;
        firebaseBindRef([key], onFilteredPropValue(key));
      } else {
        var value = scope[name] && scope[name][key];
        invokeChange('child_removed', [], key, value, true);
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
      var update = function() {
        if (!self.isReady) {
          //First time value comes, merge it in and push it
          scope[name] = fireMerge(value, scope[name]);
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
      };
      if (scope.$evalAsync) {
        scope.$evalAsync(update);
      } else {
        update();
      }
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
          if (self.isReady && scope.$evalAsync) scope.$evalAsync(function() {});
        }
      };
    }

    function setReady() {
      if (!self.isReady) {
        self.isReady = true;
        $timeout(function() {
          readyDeferred.resolve();
        });
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
      listen('child_added');
      listen('child_removed');
      listen('child_changed');
      if (onValue) {
        listen('value');
      }
      function listen(type) {
        addListener(watchRef, type, function(snap) {
          var key = snap.name();
          var value = snap.val();
          switch(type) {
            case 'child_added':
              // For objects, watch each child.
              if (angular.isObject(value)) {
                firebaseBindRef(path.concat(key));
              }
              invokeChange(type, path, key, value, true);
              break;
            case 'child_changed':
              // Only call changes at the leaf, otherwise ignore.
              if (!angular.isObject(value)) {
                invokeChange(type, path, key, value, true);
              }
              break;
            case 'child_removed':
              firebaseUnbindRef(path.concat(key), value);
              invokeChange(type, path, key, value, true);
              break;
            case 'value':
              (onValue || angular.noop)(value);
          }
        });
      }
    }

    function firebaseUnbindRef(path, value) {
      path = path || [];
      var childRef = getRefFromPath(path);
      //Unbind this ref, then if the value removed is an object, unbind anything watching
      //all of the object's child key/value pairs.
      //Eg if we remove an object { a: 1, b: { c: { d: 'e' } } }, it should call .off()
      //on the parent, a/b, a/b, and a/b/c
      if (angular.isObject(value)) {
        angular.forEach(value, function(childValue, childKey) {
          if (!angular.isString(childKey) || childKey.charAt(0) !== '$') {
            firebaseUnbindRef(path.concat(childKey), childValue);
          }
        });
      }
      removeListeners(childRef);
    }

    function invokeChange(type, path, key, value, remember) {
      function update() {
        var parsed = parsePath($parse, name, path);
        var changeScope;
        switch(type) {
          case 'child_removed':
            remove(parsed(scope), key, value);
            if (remember && reporter)
              remove(parsed(reporter.savedScope), key, angular.copy(value));
            break;
          case 'child_added':
          case 'child_changed':
            set(parsed(scope), key, value);
            if (remember && reporter)
              set(parsed(reporter.savedScope), key, angular.copy(value));
        }
      }
      if (scope.$evalAsync) {
        scope.$evalAsync(update);
      } else {
        update();
      }
    }
  }

  function remove(scope, key, value) {
    if (angular.isArray(scope)) {
      scope.splice(key, 1);
    }  else if (scope) {
      delete scope[key];
    }
  }

  function set(scope, key, value) {
    if (scope) scope[key] = value;
  }

  function parsePath($parse, name, path) {
    //turn ['key with spaces',  '123bar'] into 'name["key with spaces"]["123bar"]'
    var expr = name;
    for (var i=0, ii=path.length; i<ii; i++) {
      if (angular.isNumber(path[i])) {
        expr += '[' + path[i] + ']';
      } else {
        //We're sure to escape keys with quotes in them,
        //so eg ['quote"key"'] turns into 'scope["quote\"key]'
        expr += '["' + path[i].replace(/"/g, '\\"') + '"]';
      }
    }
    return $parse(expr);
  }

  //fireCopy: copy a value and remove $-prefixed attrs
  function fireCopy(value) {
    //Do nothing for arrays and primitives
    if (angular.isObject(value)) {
      var cloned = angular.isArray(value) ? new Array(value.length) : {};
      for (var key in value) {
        if (value.hasOwnProperty(key) && key.charAt(0) !== '$' && angular.isDefined(value[key])) {
          if (angular.isObject(value[key])) {
            cloned[key] = fireCopy(value[key]);
          } else {
            cloned[key] = value[key];
          }
        }
      }
      return cloned;
    }
    return value;
  }

  function fireMerge(remote, local) {
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
    } else if ((remote === undefined || remote === null) && angular.isDefined(local)) {
      return local;
    } else {
      //Eg if remote is a primitive this will fire
      return remote;
    }
  }

  var FIRE_COMPARE_MAX_DEPTH = 6;

  function makeObjectReporter(object, name, callback) {
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
      if (newValue === undefined) newValue = null;
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
        if (oldValue.length > newValue.length) {
          for (i=newValue.length,ii=oldValue.length; i<ii; i++) {
            reportChange(path.concat(key, i), null);
          }
        }
        oldValue.length = newValue.length;
        //copy the items to oldValue and look for changes
        for (var i=0, ii=newValue.length; i<ii; i++) {
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
  }
}]);
