import {MercatorCameraHelper} from './mercator_camera_helper.ts';
import {VerticalPerspectiveCameraHelper} from './vertical_perspective_camera_helper.ts';

import type Point from '@mapbox/point-geometry';
import type {CameraForBoxAndBearingHandlerResult, EaseToHandlerResult, EaseToHandlerOptions, FlyToHandlerResult, FlyToHandlerOptions, ICameraHelper, MapControlsDeltas} from './camera_helper.ts';
import type {LngLat, LngLatLike} from '../lng_lat.ts';
import type {IReadonlyTransform, ITransform} from '../transform_interface.ts';
import type {GlobeProjection} from './globe_projection.ts';
import type {CameraForBoundsOptions} from '../../ui/camera.ts';
import type {LngLatBounds} from '../lng_lat_bounds.ts';
import type {PaddingOptions} from '../edge_insets.ts';

/**
 * @internal
 */
export class GlobeCameraHelper implements ICameraHelper {
    private _globe: GlobeProjection;
    private _mercatorCameraHelper: MercatorCameraHelper;
    private _verticalPerspectiveCameraHelper: VerticalPerspectiveCameraHelper;

    constructor(globe: GlobeProjection) {
        this._globe = globe;
        this._mercatorCameraHelper = new MercatorCameraHelper();
        this._verticalPerspectiveCameraHelper = new VerticalPerspectiveCameraHelper();
    }

    get useGlobeControls(): boolean { return this._globe.useGlobeRendering; }

    get currentHelper(): ICameraHelper {
        return this.useGlobeControls ? this._verticalPerspectiveCameraHelper : this._mercatorCameraHelper;
    }

    handlePanInertia(pan: Point, transform: IReadonlyTransform): {
        easingCenter: LngLat;
        easingOffset: Point;
    } {
        return this.currentHelper.handlePanInertia(pan, transform);
    }

    handleMapControlsRollPitchBearingZoom(deltas: MapControlsDeltas, tr: ITransform): void {
        this.currentHelper.handleMapControlsRollPitchBearingZoom(deltas, tr);
    }

    handleMapControlsPan(deltas: MapControlsDeltas, tr: ITransform, preZoomAroundLoc: LngLat): void {
        this.currentHelper.handleMapControlsPan(deltas, tr, preZoomAroundLoc);
    }

    /**
     * Solves the fit in the projection the map will have at the fitted zoom, not the one it has now:
     * a fit that starts past the globe-to-mercator transition and ends on the globe is solved on the sphere,
     * and the reverse. The helper is switched at most twice.
     */
    cameraForBoxAndBearing(options: CameraForBoundsOptions, fitPadding: PaddingOptions, mapPadding: PaddingOptions, bounds: LngLatBounds, bearing: number, tr: ITransform): CameraForBoxAndBearingHandlerResult {
        let useGlobe = this.useGlobeControls;
        let result: CameraForBoxAndBearingHandlerResult;
        for (let attempt = 0; attempt < 3; attempt++) {
            const candidate = tr.clone();
            candidate.setTransitionState(useGlobe ? 1 : 0);
            const helper = useGlobe ? this._verticalPerspectiveCameraHelper : this._mercatorCameraHelper;
            result = helper.cameraForBoxAndBearing(options, fitPadding, mapPadding, bounds, bearing, candidate);
            if (!result) {
                return result;
            }
            const globeAtTarget = this._globe.transitionStateAtZoom(result.zoom) > 0;
            if (globeAtTarget === useGlobe) {
                return result;
            }
            useGlobe = globeAtTarget;
        }
        return result;
    }

    /**
     * Handles the zoom and center change during camera jumpTo.
     * A jump to a zoom with the other projection is constrained by the projection at that zoom: a jump from
     * past the globe-to-mercator transition to a world view would otherwise have its center clamped by mercator's
     * rules, which keep the world filling the viewport.
     */
    handleJumpToCenterZoom(tr: ITransform, options: { zoom?: number; center?: LngLatLike }): void {
        const targetState = this._otherTransitionStateAt(options.zoom);
        if (targetState === undefined) {
            this.currentHelper.handleJumpToCenterZoom(tr, options);
            return;
        }
        tr.setTransitionState(targetState);
        this._helperFor(targetState).handleJumpToCenterZoom(tr, options);
    }

    /**
     * Handles an easeTo. An animation that ends at a zoom with the other projection has its target computed in that
     * projection, and its last frame constrained by it, as {@link GlobeCameraHelper.handleJumpToCenterZoom} does.
     */
    handleEaseTo(tr: ITransform, options: EaseToHandlerOptions): EaseToHandlerResult {
        const targetState = this._otherTransitionStateAt(options.zoom);
        if (targetState === undefined) {
            return this.currentHelper.handleEaseTo(tr, options);
        }
        const result = this._inTransitionState(tr, targetState, () => this._helperFor(targetState).handleEaseTo(tr, options));
        const easeFunc = result.easeFunc;
        return {
            ...result,
            easeFunc: (k: number) => {
                this._setTransitionStateForFrame(tr, k, targetState);
                easeFunc(k);
            }
        };
    }

    /**
     * Handles a flyTo, with the target and the last frame in the projection of the target zoom, as for easeTo.
     */
    handleFlyTo(tr: ITransform, options: FlyToHandlerOptions): FlyToHandlerResult {
        const targetState = this._otherTransitionStateAt(options.zoom);
        if (targetState === undefined) {
            return this.currentHelper.handleFlyTo(tr, options);
        }
        const result = this._inTransitionState(tr, targetState, () => this._helperFor(targetState).handleFlyTo(tr, options));
        const easeFunc = result.easeFunc;
        return {
            ...result,
            easeFunc: (k: number, scale: number, centerFactor: number, pointAtOffset: Point) => {
                this._setTransitionStateForFrame(tr, k, targetState);
                easeFunc(k, scale, centerFactor, pointAtOffset);
            }
        };
    }

    /**
     * The projection's transition state at `zoom` when it is on the other side of the globe-to-mercator transition
     * from the current one, otherwise undefined.
     */
    private _otherTransitionStateAt(zoom: number | undefined): number | undefined {
        if (typeof zoom !== 'number') {
            return undefined;
        }
        const state = this._globe.transitionStateAtZoom(zoom);
        return (state > 0) !== this.useGlobeControls ? state : undefined;
    }

    private _helperFor(transitionState: number): ICameraHelper {
        return transitionState > 0 ? this._verticalPerspectiveCameraHelper : this._mercatorCameraHelper;
    }

    private _inTransitionState<T>(tr: ITransform, transitionState: number, run: () => T): T {
        tr.setTransitionState(transitionState);
        try {
            return run();
        } finally {
            tr.setTransitionState(this._globe.transitionState);
        }
    }

    /** Frames follow the projection of the zoom they start at, and the last one is in the target's. */
    private _setTransitionStateForFrame(tr: ITransform, k: number, targetState: number): void {
        tr.setTransitionState(k >= 1 ? targetState : this._globe.transitionStateAtZoom(tr.zoom));
    }
}