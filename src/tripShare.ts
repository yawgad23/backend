import type { Express, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { ADMIN_COLLECTIONS, adminFirestore, getAdminAuth } from './firebaseAdmin';

const ACTIVE_STATUSES = new Set(['matched', 'driver_arriving', 'driver_arrived', 'in_progress']);
const SHARE_DURATION_MS = 8 * 60 * 60 * 1000;

function tokenFrom(req: Request) { return String(req.params.token || '').trim(); }
function safeText(value: unknown) { return String(value || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]!)); }

async function findSharedRide(token: string) {
  if (!token || token.length < 24) return null;
  return (await adminFirestore.list(ADMIN_COLLECTIONS.RIDES, { share_token: token }, null, 'desc', 1))[0] || null;
}

function isShareActive(ride: Record<string, any>) {
  return Boolean(ride.share_token) && ACTIVE_STATUSES.has(String(ride.status || '')) && new Date(String(ride.share_expires_at || 0)).getTime() > Date.now();
}

async function publicTrackingState(token: string) {
  const ride = await findSharedRide(token);
  if (!ride) return { found: false };
  const active = isShareActive(ride);
  if (!active) return { found: true, active: false, status: String(ride.status || 'ended') };
  const driver = ride.driver_id ? await adminFirestore.get(ADMIN_COLLECTIONS.DRIVER_PROFILES, String(ride.driver_id)) : null;
  const location = driver?.current_location || null;
  return {
    found: true,
    active: true,
    status: String(ride.status),
    pickup: String(ride.pickup_address || ride.pickup?.address || 'Pickup'),
    destination: String(ride.destination_address || ride.destination?.address || 'Destination'),
    driverName: String(ride.driver_name || 'Your HY3N driver'),
    vehicle: String(ride.driver_vehicle || ''),
    plate: String(ride.driver_plate || ''),
    location: location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude)) ? {
      latitude: Number(location.latitude), longitude: Number(location.longitude), heading: Number(location.heading || 0), updatedAt: String(location.recorded_at || driver?.last_location_update || ''),
    } : null,
  };
}

function trackingPage(token: string) {
  const tokenJson = JSON.stringify(token).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>HY3N Live Trip</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>html,body,#map{height:100%;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#151515}.leaflet-control-attribution,.leaflet-control-zoom{display:none}.card{position:fixed;z-index:900;left:16px;right:16px;bottom:20px;background:#181818;color:#fff;border-radius:22px;padding:18px 20px;box-shadow:0 12px 36px #0008}.brand{font-weight:900;letter-spacing:1px;color:#d4af37;font-size:13px}.title{font-size:22px;font-weight:800;margin:4px 0}.meta{color:#c7c7c7;font-size:14px;line-height:1.55}.status{display:inline-block;background:#006b3f;color:#fff;border-radius:999px;padding:5px 9px;font-size:12px;font-weight:800;margin-top:10px}.car{width:34px;height:34px;background:#fff;border:2px solid #171717;border-radius:18px;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px #0008;transform-origin:center}.car:after{content:'🚘';font-size:20px}.ended{background:#333}</style></head><body><div id="map"></div><section class="card"><div class="brand">HY3N · LIVE TRIP</div><div id="title" class="title">Loading live trip…</div><div id="meta" class="meta">Checking the trip link securely.</div><div id="status" class="status">LIVE</div></section><script>const token=${tokenJson};const map=L.map('map',{zoomControl:false,attributionControl:false}).setView([5.6037,-0.187],13);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);let marker;let focused=false;function setText(id,value){document.getElementById(id).textContent=value}async function refresh(){try{const r=await fetch('/api/public/trips/'+encodeURIComponent(token)+'/status',{cache:'no-store'});const s=await r.json();if(!s.found){setText('title','Trip link unavailable');setText('meta','This link may be invalid or has been removed.');setText('status','UNAVAILABLE');document.getElementById('status').className='status ended';return}if(!s.active){setText('title','Trip sharing has ended');setText('meta','The Rider has arrived or this secure link has expired.');setText('status','ENDED');document.getElementById('status').className='status ended';return}setText('title',s.driverName+' is on the way');setText('meta',s.pickup+' → '+s.destination+(s.vehicle?' · '+s.vehicle:'')+(s.plate?' · '+s.plate:''));setText('status',s.status.replace(/_/g,' ').toUpperCase());if(s.location){const p=[s.location.latitude,s.location.longitude];const icon=L.divIcon({html:'<div class="car" style="transform:rotate('+(Number(s.location.heading)||0)+'deg)"></div>',iconSize:[38,38],iconAnchor:[19,19],className:''});if(marker){marker.setLatLng(p);marker.setIcon(icon)}else{marker=L.marker(p,{icon}).addTo(map)}if(!focused){map.setView(p,15);focused=true}}}catch(e){setText('meta','Connection interrupted. Retrying…')}}refresh();setInterval(refresh,5000);</script></body></html>`;
}

export function registerTripShareRoutes(app: Express) {
  app.post('/api/rider/trips/:rideId/share', async (req, res) => {
    const auth = String(req.headers.authorization || '');
    const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!idToken) { res.status(401).json({ success: false, message: 'Please sign in before sharing a trip.' }); return; }
    try {
      const riderId = (await getAdminAuth().verifyIdToken(idToken)).uid;
      const ride = await adminFirestore.get(ADMIN_COLLECTIONS.RIDES, String(req.params.rideId || ''));
      if (!ride || String(ride.rider_id || '') !== riderId) { res.status(403).json({ success: false, message: 'This trip does not belong to your Rider account.' }); return; }
      if (!ACTIVE_STATUSES.has(String(ride.status || ''))) { res.status(409).json({ success: false, message: 'Only an active trip can be shared.' }); return; }
      const token = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + SHARE_DURATION_MS).toISOString();
      await adminFirestore.update(ADMIN_COLLECTIONS.RIDES, ride.id, { share_token: token, share_expires_at: expiresAt, share_started_at: new Date().toISOString() });
      const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
      const origin = `${forwardedProtocol || req.protocol}://${req.get('host')}`;
      res.status(201).json({ success: true, trackingUrl: `${origin}/track/${token}`, expiresAt });
    } catch (error) { console.error('[TripShare] Link generation failed:', error); res.status(503).json({ success: false, message: 'Live trip sharing is temporarily unavailable.' }); }
  });

  app.get('/track/:token', (_req, res) => res.status(200).type('html').send(trackingPage(tokenFrom(_req))));
  app.get('/api/public/trips/:token/status', async (req, res) => {
    try { res.status(200).json(await publicTrackingState(tokenFrom(req))); }
    catch (error) { console.error('[TripShare] Public status failed:', error); res.status(503).json({ found: false }); }
  });
}
