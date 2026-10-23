import {beforeEach, describe, expect, test} from 'vitest';
import {beforeMapTest} from '../../util/test/util.ts';
import {Map} from '../map.ts';
import {LngLat} from '../../geo/lng_lat.ts';

import type {PaddingOptions} from '../../geo/edge_insets.ts';

beforeEach(() => {
    beforeMapTest();
    global.fetch = null;
});

const globeStyle = {version: 8 as const, sources: {}, layers: [], projection: {type: 'globe' as const}};

function createSizedMap(width: number, height: number, options: Record<string, unknown> = {}): Map {
    const container = window.document.createElement('div');
    Object.defineProperty(container, 'clientWidth', {value: width, configurable: true});
    Object.defineProperty(container, 'clientHeight', {value: height, configurable: true});
    return new Map({container, interactive: false, attributionControl: false, maplibreLogo: false, style: globeStyle, ...options} as any);
}

type Box = [[number, number], [number, number]];

const BOUNDS: Record<string, Box> = {
    germany: [[5.87, 47.27], [15.04, 55.06]],
    norway: [[4.5, 57.9], [31.2, 71.2]],
    brazil: [[-73.99, -33.75], [-34.79, 5.27]],
    chile: [[-75.7, -55.98], [-66.4, -17.5]],
    russia: [[19.6, 41.2], [191.0, 81.9]],
    fijiAcrossTheAntimeridian: [[177.0, -21.0], [182.0, -12.0]],
    africa: [[-17.6, -34.9], [51.4, 37.4]],
    berlinMitte: [[13.37, 52.5], [13.42, 52.53]],
};

// Russia reaches 82N: with more padding at the top than at the bottom, centring it needs a center further north
// than the globe lets the center go at that zoom. It is fitted inside the padded viewport, neither centred nor
// as large as it could be.
const CENTER_OUT_OF_REACH = new Set(['russia, uneven']);

const PADDINGS: Record<string, PaddingOptions> = {
    none: {top: 0, bottom: 0, left: 0, right: 0},
    even: {top: 80, bottom: 80, left: 80, right: 80},
    uneven: {top: 120, bottom: 40, left: 20, right: 100},
};

const VIEWPORTS: Record<string, [number, number]> = {
    phone: [360, 800],
    desktop: [1440, 900],
};

const START_ZOOMS: Record<string, number> = {
    globe: 1,
    transition: 11.5,
    mercator: 14,
};

function edgeSamples([[west, south], [east, north]]: Box, perEdge: number): LngLat[] {
    const samples: LngLat[] = [];
    for (let i = 0; i < perEdge; i++) {
        const t = i / perEdge;
        samples.push(
            new LngLat(west + (east - west) * t, north),
            new LngLat(east, north + (south - north) * t),
            new LngLat(east + (west - east) * t, south),
            new LngLat(west, south + (north - south) * t));
    }
    return samples;
}

/** Where the bounds' edges land after the fit, against the padded viewport. */
function measureFit(map: Map, box: Box, padding: PaddingOptions, width: number, height: number) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const lngLat of edgeSamples(box, 16)) {
        const p = map.project(lngLat);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const left = minX - padding.left;
    const right = width - padding.right - maxX;
    const top = minY - padding.top;
    const bottom = height - padding.bottom - maxY;
    return {
        outside: -Math.min(left, right, top, bottom),
        // The smallest gap to a padded edge: 0 when the bounds touch one.
        slack: Math.max(0, Math.min(left, right, top, bottom)),
        horizontalOffset: (left - right) / 2,
        verticalOffset: (top - bottom) / 2,
    };
}

describe('fitBounds on the globe', () => {
    for (const [viewportName, [width, height]] of Object.entries(VIEWPORTS)) {
        for (const [boundsName, box] of Object.entries(BOUNDS)) {
            for (const [paddingName, padding] of Object.entries(PADDINGS)) {
                for (const [startName, startZoom] of Object.entries(START_ZOOMS)) {
                    const name = `${boundsName}, ${viewportName}, ${paddingName} padding, from ${startName}`;
                    const fit = async () => {
                        const map = createSizedMap(width, height);
                        await map.once('style.load');
                        const middle = new LngLat((box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2).wrap();
                        map.jumpTo({center: startZoom < 5 ? [0, 20] : middle, zoom: startZoom});
                        map.redraw();

                        map.fitBounds(box, {padding, animate: false});
                        map.redraw();
                        const measured = measureFit(map, box, padding, width, height);
                        map.remove();
                        return measured;
                    };

                    test(`${name}: every edge point is inside the padded viewport`, async () => {
                        expect((await fit()).outside).toBeLessThanOrEqual(1);
                    });

                    // Unless the center would have to pass the latitude the zoom allows.
                    test.skipIf(CENTER_OUT_OF_REACH.has(`${boundsName}, ${paddingName}`))(`${name}: the bounds are centred and fill the padded viewport`, async () => {
                        const measured = await fit();
                        expect(measured.slack).toBeLessThanOrEqual(1);
                        expect(Math.abs(measured.horizontalOffset)).toBeLessThanOrEqual(1);
                        expect(Math.abs(measured.verticalOffset)).toBeLessThanOrEqual(1);
                    });
                }
            }
        }
    }

    test('a map constructed with bounds and a globe style lands where fitBounds does after load', async () => {
        for (const box of [BOUNDS.germany, BOUNDS.norway, BOUNDS.brazil]) {
            const constructed = createSizedMap(1440, 900, {bounds: box});
            await constructed.once('style.load');

            const fitted = createSizedMap(1440, 900);
            await fitted.once('style.load');
            fitted.fitBounds(box, {animate: false});

            expect(constructed.getZoom()).toBeCloseTo(fitted.getZoom(), 6);
            expect(constructed.getCenter().lng).toBeCloseTo(fitted.getCenter().lng, 6);
            expect(constructed.getCenter().lat).toBeCloseTo(fitted.getCenter().lat, 6);
            constructed.remove();
            fitted.remove();
        }
    });

    test('a map constructed with bounds keeps a camera moved before the style loads', async () => {
        const map = createSizedMap(1440, 900, {bounds: BOUNDS.germany});
        map.jumpTo({center: [100, 10], zoom: 3});
        await map.once('style.load');

        expect(map.getZoom()).toBeCloseTo(3, 6);
        expect(map.getCenter().lng).toBeCloseTo(100, 6);
        map.remove();
    });

    test('a box that cannot be seen whole on a globe still gives a camera', async () => {
        const map = createSizedMap(1440, 900);
        await map.once('style.load');

        const camera = map.cameraForBounds([[-180, -85], [180, 85]]);

        expect(camera).toBeDefined();
        expect(Number.isFinite(camera.zoom)).toBe(true);
        map.remove();
    });
});
