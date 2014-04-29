describe('The fire service', function () {
  'use strict';

  beforeEach(function () {
    module('altfire');
  });

  it('should find the altfire module and run a trivial test successfully',
    inject(function (fire) {
      expect(fire).toBeTruthy();
    }
  ));
});
