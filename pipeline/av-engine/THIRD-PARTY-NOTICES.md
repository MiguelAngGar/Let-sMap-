# Third-party notices — pipeline/av-engine

## Algorithm

The tempo detection algorithm implemented here is described in
Bram van de Wetering, *"Non-causal Beat Tracking for Rhythm Games"*,
and is best known as the BPM detection of [ArrowVortex](https://arrowvortex.ddrnl.com/).
This module is an independent implementation of that algorithm.

## AudioSync

The onset detection code (`onsets.js`) was ported using
[AudioSync](https://github.com/Caeden117/AudioSync) as reference.

```
MIT License

Copyright (c) 2023 Caeden Statia

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
