# Paygent video ad

`paygent-ad.mp4`: 33 seconds, 1920×1080, H.264 + AAC.

The ad is an HTML page (`ad.html`) where every frame is a function of time. `make.mjs` steps it frame by frame in headless Chrome, and `enc.html` encodes the frames and a generated soundtrack with WebCodecs, then muxes an MP4. No ffmpeg needed.

```sh
cd marketing
npm ci --ignore-scripts
npm run stills   # review frames in stills/
npm run ad       # renders paygent-ad.mp4 (about 10 minutes)
```

Needs Google Chrome at the default macOS path. Not part of the Paygent package.
