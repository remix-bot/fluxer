export default {
  prefix: function(value, data) {
    // prefix change hook — Settings handles persistence
  },
  pfp: function(value, data) {
    // Profile picture customisation is not supported on Fluxer via the bot API
    if (value !== "default") {
      return "Profile picture customisation is not supported on Fluxer.";
    }
  }
};
