System.register([], function (_export) {
  var reporter;

  var events = [];
  function reporter (name) {
    events.push(name);
  }
  _export('reporter', reporter);
  _export('events', events);

  return {
    setters: [],
    execute: function () {
      reporter('c');
      return new Promise(resolve => setTimeout(resolve, 10))
      .then(function () {
        reporter('c');
      });
    }
  };
});
