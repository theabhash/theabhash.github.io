# My Commute

A phone web app that shows everything on one screen:

- **Buses**: live GPS for buses **1035** and **4028** on a map, like AnyTrip. Each number is matched against route numbers and fleet/vehicle IDs.
- **Trains**: the next 5 trains, like Opal Travel. Before 12 pm it shows **Glenfield → Redfern**; from 12 pm it shows **Redfern → Glenfield**. Each train shows the line, platform, delays and cancellations.

It refreshes buses every 20 s and trains every 60 s. It stops refreshing while it's in the background.

## Setup

1. **Get a free API key.** Register at <https://opendata.transport.nsw.gov.au>, create an application, and give it access to:
   - *Trip Planner APIs*
   - *Public Transport – Realtime Vehicle Positions* (GTFS-realtime)
2. **Open the app.** Once this is on GitHub Pages, it's at `https://theabhash.github.io/transit/`.
3. Tap **⚙ Settings** and paste the key. You can also change the bus numbers, stations and the 12 pm switch time there.
4. **Add it to your home screen:**
   - iPhone (Safari): Share → *Add to Home Screen*
   - Android (Chrome): ⋮ → *Add to Home screen* / *Install app*

## If the buses don't show

- **"Not running right now"** means no bus matching that number is sending GPS. Buses only appear while they're in service.
- To check what your bus is called in the live feed, use **Settings → Bus finder**. Type `1035` to list every live bus whose route, fleet ID or label contains it.

## If you see a CORS / "browser blocked" error

Deploy `proxy-worker.js` as a free Cloudflare Worker. The steps are in the comments at the top of that file. Then put the worker URL in **Proxy URL** in Settings. This also keeps your API key off your phone.

Data: Transport for NSW Open Data. Map: © OpenStreetMap contributors.
