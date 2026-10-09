/**
 * Working out which addresses the app is reachable on, so the startup banner
 * can print a URL you can actually open from another device.
 */

import os from 'node:os';

/**
 * Tailscale hands out addresses from 100.64.0.0/10, the CGNAT range. Matching
 * the range means no dependency on the Tailscale CLI being installed.
 */
const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

function ipv4Interfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => (
    (addresses ?? [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => ({ name, address: address.address }))
  ));
}

/** Addresses that belong to a tailnet. */
export function tailscaleAddresses() {
  return ipv4Interfaces().filter(({ address }) => CGNAT.test(address));
}

/** Ordinary LAN addresses - Wi-Fi, Ethernet and the like. */
export function lanAddresses() {
  return ipv4Interfaces().filter(({ address }) => !CGNAT.test(address));
}

/**
 * Turns the HOST setting into an address to bind to.
 *
 * - `tailscale` binds only to the tailnet address, so the app is not exposed
 *   on whatever other network the machine is attached to.
 * - `localhost` binds to loopback only, which is what you want when
 *   `tailscale serve` is doing the listening.
 * - anything else is passed through; the default is every interface.
 */
export function resolveHost(host) {
  if (!host || host === 'any' || host === '0.0.0.0') return { host: '0.0.0.0', mode: 'any' };

  if (host === 'localhost' || host === '127.0.0.1') return { host: '127.0.0.1', mode: 'localhost' };

  if (host === 'tailscale') {
    const [first] = tailscaleAddresses();
    if (!first) {
      throw new Error(
        'HOST=tailscale was requested but no tailnet address was found. '
        + 'Is Tailscale connected? Run "tailscale status" to check.',
      );
    }
    return { host: first.address, mode: 'tailscale', interface: first.name };
  }

  return { host, mode: 'explicit' };
}

/**
 * The lines printed at startup: where to open the app from, and what is needed
 * for the GPS button to work from each one.
 */
export function startupUrls(port, binding) {
  const lines = [];
  const url = (hostname) => `http://${hostname}:${port}`;

  if (binding.mode === 'any' || binding.mode === 'localhost') {
    lines.push({ url: url('localhost'), note: 'this machine - GPS works (localhost is a secure context)' });
  }

  if (binding.mode === 'any' || binding.mode === 'tailscale') {
    for (const { address } of tailscaleAddresses()) {
      lines.push({ url: url(address), note: 'over Tailscale - GPS blocked on a bare IP, see "tailscale serve" below' });
    }
  }

  if (binding.mode === 'any') {
    for (const { address, name } of lanAddresses()) {
      lines.push({ url: url(address), note: `local network via ${name}` });
    }
  }

  if (binding.mode === 'explicit') lines.push({ url: url(binding.host), note: '' });

  return lines;
}
