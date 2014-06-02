describe('The fire service', function() {
  'use strict';

  var fire;

  beforeEach(function() {
    module('altfire');
  });

  beforeEach(inject(function(_fire_) {
    fire = _fire_;
    fire.setDefaultRoot('https://altfire-test.firebaseio.com/');
  }));

  it('should find the altfire module and run a trivial test successfully', function() {
    expect(fire).toBeTruthy();
  });

});
