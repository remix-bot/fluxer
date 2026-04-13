export default {
  prefix: function(value, data) {
    // prefix change hook — Settings handles persistence
  },

  pfp: function(value, data) {
    if (value !== "default") {
      return "Profile picture customisation is not supported on Fluxer.";
    }
  },

  // stay_247 is managed exclusively by the %247 command and auto-join logic.
  stay_247: function(value, data) {
    return false;
  },
};