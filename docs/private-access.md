---
title: Connecting from a phone
---

# Connecting from a phone

The bot hosts the viewer. A desktop browser doesn't have to stay open. The default URL uses loopback, so it works on the bot's machine only. Opening that same loopback address on a phone points the phone back at itself.

For a phone on your private network, configure HTTPS on the bot. Use a specific private bind address, a hostname the phone can resolve to the bot, and a certificate the phone already trusts for that hostname. Pass the same origin you will open in the browser, including the port if it isn't 443. The certificate chain and private key are PEM file paths.

```crystal
tls = RosegoldViewer::HTTPS.new(
  bind_address: ENV["VIEWER_BIND_ADDRESS"],
  origin: ENV["VIEWER_ORIGIN"],
  certificate_chain: ENV["VIEWER_CERTIFICATE_CHAIN"],
  private_key: ENV["VIEWER_PRIVATE_KEY"],
)
viewer = RosegoldViewer::Host.new(https: tls, pack_directory: ENV["VIEWER_PACK"])
```

Bind the host to the bot and enable it as in the [mounting example](getting-started.html#3-mount-it-on-your-bot). Open the HTTPS URL on the phone and enter the separate pairing secret. Keep the private key on the host and keep pairing secrets out of URLs, logs, and recordings.

If the page doesn't load, check the phone's network route, DNS, and certificate before debugging pairing. If it loads but offers no manual controls, check whether the script gave intervention permission. You don't need a public port forward or a hosted demo for either step.
