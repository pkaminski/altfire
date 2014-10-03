altfire
=======

Alternative AngularJS bindings for Firebase, based on [ajoslin/angular-burn](github.com/ajoslin/angular-burn).  Not very complete yet but offers the following advantages over the officially supported [AngularFire](https://github.com/firebase/angularFire):

- **Minimal change propagation in both directions.**  When a deeply nested attribute is changed, either locally or remotely, only that branch of the model is propagated to the other side.  This helps minimize bandwidth and minimizes opportunities for collisions.
- **A sensible initial-fetch merging model,** that prefers the remote value (even if it comes after a local value has been set), but will do its best to preserve both.
- **Simple reference-following (aka "filtering").**  Since Firebase lacks query capabilities you'll often end up with IDs pointing to collection items in some other part of the datastore.  These can be automatically dereferenced for you whether they're stored as keys or values.  ([FirebaseIndex](https://github.com/Zenovations/FirebaseIndex) provides more powerful features but at the expense of significant complexity, whereas this is the 80% solution.)
- **Datastore path interpolation.**  When binding a controller or directive to its Firebase data, the path often depends on scope properties.  You can use a convenient Angular-style template to form the path, and the binding will be automatically updated if variable values change.
- **Scope independence.**  All features (two-way binding, one-way binding, interpolation, lifecycle management, etc.) work both within controller scopes and outside of them (e.g., in services).  (AngularFire will only do two-way binding with scopes, and one-way binding outside of them.)
- **API passthrough.**  Rather than trying to completely wrap the Firebase API, you can easily retrieve a full Firebase reference and manipulate it directly.
- **Array normalization.**  Firebase has a misguided heuristic where it will sometimes convert an object with integer keys into an array.  This can cause some very confusing bugs, so altfire makes sure you're always dealing with objects.

There are many things still missing (some of which I'm working on), so I don't recommend using it in production yet:
- Few tests.  (But I've started putting those in.)
- No matching authentication service.
- Minimal documentation (in the source code).

Quick Start
-----------

```js
angular.module('myApp', ['altfire'])
.run(function(fire) {
  fire.setDefaultRoot('https://myfirebase.firebaseio.com');
})
.controller('MyCtrl', function($scope, fire) {
  $scope.currentUserId = 'u123';
  fire.connect($scope, {
    users: {bind: 'users'},
    currentUser: {bind: 'users/{{currentUserId}}'},
    friends: {pull: 'users/#', viaKeys: 'users/{{currentUserId}}/friends'}
  });
});
```

Creating a Minified Distribution Build
--------------------------------------

Ensure you have

1. The dependencies installed (`npm run setup` if you do not)
2. grunt-cli installed (`sudo npm install -g grunt-cli`)

Then simply run

	grunt


Running Tests
-------------

Assuming you already have grunt-cli installed (if not, install with `sudo npm install -g grunt-cli`)

Run `npm run setup` to grab all the dependencies

Then run

	grunt test

