export default {
  prefix: function(value, data) {
  },

  pfp: function(value, data) {
    if (value !== "default") {
      return "Profile picture customisation is not supported on Fluxer.";
    }
  },

  stay_247: function(value, data) {
    return false;
  },
};