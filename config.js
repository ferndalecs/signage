// Sign Player settings for IT. Fill these in once when setting up.
// Everything staff change day to day (which deck, timing) lives in the Google Sheet instead.
// Changes here reach the signs at their next nightly reload or reboot.

export default {
  // Link to the settings Sheet's "Settings" tab, published as CSV:
  // in the Sheet, File › Share › Publish to web › choose the Settings tab and
  // "Comma-separated values (.csv)" › Publish, then paste the link here.
  settingsCsvUrl: '',

  // How often each sign checks the Sheet for changes, in seconds.
  pollSeconds: 60,

  // Device-local time (24-hour HH:MM) when the player reloads itself each night.
  nightlyReloadAt: '03:00',

  // Used when the Sheet leaves "Seconds per slide" or "Refresh every (minutes)" blank.
  defaultSecondsPerSlide: 10,
  defaultRefreshMinutes: 5,
};
