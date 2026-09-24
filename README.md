# Sign Player

Plays one Google Slides deck full screen on the school's ChromeOS signs. It replaces Chrome Sign Builder, which stopped working in kiosk mode from ChromeOS 151.

- **Power on:** the sign starts the player by itself. It runs as a ChromeOS web kiosk app, so nobody logs in.
- **Content:** the player shows the deck named in the **Digital Signage Settings** Google Sheet.
- **Edits:** changes to the deck appear on the signs within about 10 minutes.
- **Network drops:** the deck keeps playing, and it reloads itself once the network is back.

## For staff: changing what's on the signs

| To… | Do this | Signs update within |
|---|---|---|
| Change a slide | Edit the deck as normal. | about 10 minutes |
| Show a different deck | In that deck, go to **File › Share › Publish to web › Publish** and copy the link. Paste it into **Slides link** in the Settings sheet. | about 7 minutes |
| Change the timing | Change **Seconds per slide** in the Settings sheet. | about 7 minutes |

Good to know:
- **Loop length:** every time the signs refresh ("Refresh every (minutes)", 5 by default), the deck starts again from slide 1. If one run through the deck (slides × seconds per slide) takes longer than that, the last slides never appear, so raise "Refresh every". For example, 45 slides × 10 s = 7.5 minutes, so set it to 10.
- **Publishing:** the deck must stay published to the web. If it isn't, the signs show a Google error page.
- **Column A:** don't rename the labels in column A of the Sheet. The player finds each setting by its label.

## How it works

```
Power on ─► ChromeOS auto-launches the web kiosk (no login)
         ─► Sign Player  https://<account>.github.io/signage/   (a copy is kept on the sign for offline starts)
              ├─ checks the Settings tab of the Sheet (published as CSV) every minute
              └─ shows the deck full screen:
                 docs.google.com/presentation/d/e/<id>/embed?start=true&loop=true&delayms=…&rm=minimal
```

- **Links:** whatever link is pasted into the Sheet, the player rebuilds it as the deck's `/embed` address. Published `/pub` pages refuse to be shown inside another page, so they can't be used directly.
- **Refreshing:** a playing Slides deck never picks up edits by itself. So the player reloads it every "Refresh every" minutes, and whenever the Sheet changes. A new deck loads invisibly on top and fades in, with no black flash.
- **Keeping the last good settings:** if the Sheet has a problem, the sign keeps showing its current deck. It also keeps a copy of the last good settings, so it can restart without the Sheet.
- **Network problems:**
  - If the network drops, the deck keeps playing.
  - When the network returns, the deck reloads once, in case it had loaded an error page.
  - If a sign starts with no network and has nothing saved, it shows "Connecting…".
- **Every night:**
  - The player reloads itself at 03:00, which picks up new player code and clears memory.
  - The Admin console's scheduled reboot is the backstop.
- **Screen:** the player asks the browser to keep the screen on. The Admin console's kiosk power settings are still needed as well.
- **Watchdog:** if the player code ever fails to start, `index.html` reloads the page every 60 s until it works.

| File | What it is |
|---|---|
| `index.html` | The page, including the 60 s watchdog |
| `player.css` | Full screen, hidden cursor, crossfade |
| `config.js` | **IT edits this once:** the Sheet's CSV link, check interval, nightly reload time, defaults |
| `player.js` | The player |
| `lib.js` | Helpers the player uses: reading the Sheet, building the deck link, timing |
| `sw.js` | Service worker: keeps a copy of the player on the sign for offline starts |
| `tests/` | Unit tests (`npm test`) and sample settings files |

## Setting it up (IT)

### 1. The settings Sheet
1. **Create the Sheet.**
   - Create a Google Sheet called **Digital Signage Settings**, ideally in a Shared drive so it doesn't disappear when staff leave.
   - Rename the first tab to **Settings** and fill it in:

   | Setting | Value | Notes |
   |---|---|---|
   | Slides link | *(the deck's Publish to web link)* | In the deck: File › Share › Publish to web › Link |
   | Seconds per slide | 10 | Whole number, 3–300 |
   | Refresh every (minutes) | 5 | How often signs reload to show edits. Must be longer than one run through the deck (5 min = up to 30 slides at 10 s). 0 = overnight only. |
2. **Protect column A:** Data › Protect sheets and ranges. Optionally add data validation with "Reject input":
   - B2: `=REGEXMATCH(B2,"docs\.google\.com/presentation/d/e/")`
   - B3: `=AND(B3=INT(B3),B3>=3,B3<=300)`
   - B4: `=OR(B4=0,AND(B4=INT(B4),B4>=5,B4<=1440))`

   All three are "Custom formula is" rules.
3. **Publish the Settings tab:**
   - Go to **File › Share › Publish to web**.
   - Choose the **Settings** tab and **Comma-separated values (.csv)**.
   - Tick **Automatically republish when changes are made**, then **Publish**.
   - Copy the link. It looks like `https://docs.google.com/spreadsheets/d/e/2PACX-…/pub?gid=0&single=true&output=csv`.
4. **Fill in `config.js`:** paste that link into `settingsCsvUrl` in `config.js`.
5. **Share the Sheet** (edit access) with the staff who look after the signs.

The deck and the Sheet must be published to **anyone on the web**. Signs have no Google account, so anything restricted to the school's domain shows a sign-in page instead.

### 2. Put the player on GitHub Pages
1. **Create the repository.** Use a GitHub account or organization owned by the school, and create an empty **public** repository called `signage`. The account name becomes part of every sign's address, so pick one that will last.
2. **Push these files** to its `main` branch:
   ```
   git remote add origin https://github.com/<account>/signage.git
   git push -u origin main
   ```
3. **Turn on Pages:** in the repository, go to **Settings › Pages** and choose **Deploy from a branch**, then **main**, **/ (root)**, then **Save**.
4. **Check it:** after a minute or two, open `https://<account>.github.io/signage/?debug=1` in Chrome. The deck should play, with a status panel in the corner.

### 3. Web filter
Allow these for the signage devices:
- `<account>.github.io`
- `docs.google.com`
- `*.googleusercontent.com` (the published CSV is served from there)

### 4. Pilot on one sign
1. **Pilot OU.** In the Google Admin console, create a child OU under the signage OU (e.g. **Signage-Pilot**) and move one sign into it.
2. **Add the kiosk app.** Go to **Devices › Chrome › Apps & extensions › Kiosks**, select the pilot OU, then **Add (+) › Add by URL**. Enter:
   `https://<account>.github.io/signage/?debug=1`
   The kiosk address must include the `/` after `signage`.
3. **Set it as the Auto-launch app**, and remove Chrome Sign Builder from this OU.
4. **In the app's settings,** turn on **health monitoring** and **log upload**. These give you remote screenshots, remote reboot and offline alerts.
5. **Device settings for the OU:**
   - Kiosk power settings (for both AC and battery):
     - Action on idle: **Do nothing**
     - Screen dim: **0**
     - Screen off: **0**
   - **Scheduled reboot:** daily, 03:30.
   - **User data:** Do not erase local user data. This keeps the saved settings and the offline copy.
   - **Time zone:** the school's.
   - **Screen rotation:** only if the sign is in portrait.
   - **Troubleshooting tools:** off.
   - **Optional:** device sleep mode after hours.
6. **Reboot and check.** Reboot the sign and take a remote screenshot. You should see the deck with the status panel. Work through the pilot checks under "Testing".

### 5. Roll out
Repeat the steps from "Add the kiosk app" onwards on the production signage OU, using `https://<account>.github.io/signage/` without `?debug=1`. Then remove Chrome Sign Builder.

### Stopgap while signs are down
If signs stopped working before this is ready, add the deck itself as the kiosk app:
- In **Kiosks › Add by URL**, enter the deck's Publish to web link with `/pub` changed to `/embed` and `&rm=minimal` added. For example:
  `https://docs.google.com/presentation/d/e/<id>/embed?start=true&loop=true&delayms=10000&rm=minimal`
- Set it as the Auto-launch app, and add a daily scheduled reboot. Edits then show after each reboot.

## Testing

**Unit tests** (needs Node.js):
```
npm test
```

**On a PC:**
1. **Start a local server** from the folder *above* this one, so the path looks like GitHub Pages:
   ```
   cd D:\Claude
   python -m http.server 8080
   ```
2. **Open the player** at `http://localhost:8080/DigitalSignage/?debug=1&settings=<published CSV link>`.
   - `?settings=` swaps in a different Sheet without editing `config.js`.
   - `./tests/fixtures/settings.csv` also works, but its deck is made up, so Google shows "not found" inside the frame.
3. **Simulate the kiosk** with Chrome. Exit with Alt+F4.
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --user-data-dir=%TEMP%\sign-kiosk --no-first-run "http://localhost:8080/DigitalSignage/?settings=<published CSV link>"
   ```

**Pilot checks:**
- **Cold boot:** the sign goes straight to the slides without anyone touching it.
- **Edits:** an edit to a slide shows within about 10 minutes, and changing the Sheet's link swaps the deck.
- **Network drop:** unplug the network for 2 minutes, then plug it back in. The sign recovers by itself.
- **Starting offline:** power-cycle with the network unplugged. The sign recovers once the network is plugged back in.
- **Status panel:** the debug panel shows the right time zone.
- **48-hour soak:** the screen stays on, and the nightly reload and reboot are clean.

## Troubleshooting

To see the status panel on a sign, use `?debug=1` on the kiosk address (as in the pilot OU) and take a remote screenshot from the Admin console. The panel shows:
- the settings in use and where they came from;
- the deck;
- the next check;
- the wake lock;
- the last problem.

| On screen | Why | Fix |
|---|---|---|
| "Connecting…" | The sign can't reach the Sheet and has no saved copy (new sign, or network down). | Check the network, the web filter (`docs.google.com`, `*.googleusercontent.com`), and that the Settings tab is still published. |
| "Sign not set up: …" | The Sheet has a problem and the sign has nothing saved. The message says what's wrong. | Fix the Sheet as the message says. |
| Google page saying the file doesn't exist, or a sign-in page | The deck isn't published to anyone on the web, or was unpublished or deleted. | Publish the deck to the web again and check the link in the Sheet. |
| A Chrome "no internet" page | The network was down when the deck loaded. | Nothing to do: it reloads itself within about 30 s of the network coming back. |
| Deck starts over before the end | "Refresh every" is shorter than one run through the deck. | Raise "Refresh every". |
| Edits don't appear | "Refresh every" is 0 or very long, or Google hasn't republished yet. | Check the Sheet, and allow about 10 minutes. |
| Screen goes dark | Power settings. | Check the kiosk power settings in the Admin console. |
| Black screen | The player isn't loading. | Check that `<account>.github.io` is allowed, and that the kiosk address ends in `/signage/`. |

## Updating the player
1. **Make the change.** Run `npm test`, then try it on the PC.
2. **Bump the version:** change `VERSION` in `player.js`, so the status panel shows which version a sign is running.
3. **New files:** if you add a file the player needs, add it to `SHELL` in `sw.js`.
4. **Push to `main` during the school day.** GitHub Pages publishes within a minute or two, though browsers may cache the old files for up to 10 minutes.
5. **Check the pilot sign first.** Signs pick up new code at their next nightly reload (03:00) or reboot, so reboot the pilot sign from the Admin console and check it.

**Rolling back:**
- **Code:** `git revert` the change and push. Signs pick it up at their next reload or reboot, or reboot them.
- **In an emergency:** in the Admin console, set the Auto-launch app to the stopgap `/embed` address above.

**Turning off the service worker** (only if it ever misbehaves):
1. Replace `sw.js` with the code below.
2. Delete the `navigator.serviceWorker.register(…)` lines in `player.js`.
3. Push. The service worker is gone after each sign's next two reloads.

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('signage-')) await caches.delete(key);
  await self.registration.unregister();
})()));
```
