describe('The fireHelpers service', function() {
  'use strict';

  var h;

  beforeEach(function() {
    module('altfire');
  });

  beforeEach(inject(function(fireHelpers) {
    h = fireHelpers;
  }));

  describe('fireMerge', function() {
    it('primitive remote should return primitive', function() {
      expect(h.fireMerge(2, 1)).toEqual(2);
      expect(h.fireMerge('apple', {object: 'here'})).toEqual('apple');
    });

    it('arrays should concat local into remote', function() {
      expect(h.fireMerge([1, 2], [3, 4])).toEqual([3, 4, 1, 2]);
    });

    it('objects should merge remote into local', function() {
      expect(h.fireMerge({a: 1, b: 2, c: 3}, {c: 4, d: 5})).toEqual({a: 1, b: 2, c: 3, d: 5});
    });

    it('undefined remote should return local', function() {
      var local = {};
      expect(h.fireMerge(null, local)).toBe(local);
    });

    it('equal things should return local', function() {
      var local = {};
      expect(h.fireMerge({}, local)).toBe(local);
    });
  });

  describe('fireCopy', function() {
    it('primitives should return themselves', function() {
      expect(h.fireCopy(4)).toBe(4);
    });

    it('arrays should return themselves', function() {
      var array = [1, 2];
      var copied = h.fireCopy(array);
      expect(copied).toEqual(array);
    });

    it('objects should be an anulgaar.copy with no $-attrs', function() {
      var obj = {banana: true, $elephant: 4};
      var copied = h.fireCopy(obj);
      expect(copied).toEqual({banana: true});
    });

    it('object should be deep without $', function() {
      expect(h.fireCopy({
        $attr: {value: 3},
        deep: {$nope: 1, yes: 2}
      })).toEqual({
        deep: {yes: 2}
      });
    });
  });

  describe('parsePath', function() {
    var context = {foo: {}};
    var name = 'foo';

    it('should just return context for empty path', function() {
      var parsed = h.parsePath(name, []);
      expect(parsed(context)).toBe(context.foo);
    });

    it('should allow a deep object', function() {
      context.foo.banana = 6;
      var parsed = h.parsePath(name, ['banana']);
      expect(parsed(context)).toBe(6);
    });

    // TODO: test for $$firebaseData following
  });

  describe('makeObjectReporter', function() {
    var watch;
    var context;
    var results;

    function setup(initialValue) {
      context = {data: initialValue};
      results = [];
      var reporter = h.makeObjectReporter(context, 'data', function(path, value) {
        results.unshift({path: path, value: value});
      });
      watch = function() {
        results.length = 0; //new results for each test
        reporter.compare();
      };
    }

    it('should report all types of change at root', function() {
      setup(1);
      watch();
      expect(results.length).toBe(0);
      context.data = 2;
      watch();
      expect(results[0]).toEqual({path: [], value: 2});
      context.data = 'string';
      watch();
      expect(results[0]).toEqual({path: [], value: 'string'});
      context.data = [1, 2, 3];
      watch();
      expect(results[0]).toEqual({path: [], value: [1, 2, 3]});
      context.data = {a: 'b', c: 'd'};
      watch();
      expect(results[0]).toEqual({path: [], value: {a: 'b', c: 'd'}});
    });

    it('should report deep changes in object', function() {
      setup({deep: {object: {is: {deep: true}}}});
      watch();
      context.data.deep.object.extra = 6;
      watch();
      expect(results[0]).toEqual({path: ['deep', 'object', 'extra'], value: 6});
      context.data.deep.object.is.deep = 'nope';
      watch();
      expect(results[0]).toEqual({path: ['deep', 'object', 'is', 'deep'], value: 'nope'});
      context.data.deep.object.is = null;
      watch();
      expect(results[0]).toEqual({path:['deep', 'object', 'is'], value: null});
      context.data.another = {deep: {object: {here: 1}}};
      watch();
      expect(results[0]).toEqual({path: ['another'], value: {deep: {object: {here: 1}}}});
      context.data.another = {deep: false};
      watch();
      expect(results[0]).toEqual({path: ['another', 'deep'], value: false});
    });

    it('should report changes in array', function() {
      setup();
      context.data = {arr: [1, 2, 3]};
      watch();
      expect(results[0]).toEqual({path: [], value: {arr: [1, 2, 3]}});
      context.data.arr.splice(0, 1);
      watch();
      expect(results.length).toBe(3);
      expect(results).toContain({path: ['arr', 0], value: 2});
      expect(results).toContain({path: ['arr', 1], value: 3});
      expect(results).toContain({path: ['arr', 2], value: null});
      context.data.arr.push({superman: {real: false}});
      watch();
      expect(results[0]).toEqual({path: ['arr', 2], value: {superman: {real: false}}});
      context.data.arr[2].superman.fake = true;
      watch();
      expect(results[0]).toEqual({path: ['arr', 2, 'superman', 'fake'], value: true});
    });
  });

});
