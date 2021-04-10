import { select as d3Select } from 'd3-selection';
import { zoom as d3Zoom, zoomTransform as d3ZoomTransform } from 'd3-zoom';
import throttle from 'lodash.throttle';
import Kapsule from 'kapsule';
import accessorFn from 'accessor-fn';

import ColorTracker from './object-color-tracker.js';
import CanvasForceGraph from './canvas-force-graph';
import linkKapsule from './kapsule-link.js';

const HOVER_CANVAS_THROTTLE_DELAY = 800; // ms to throttle shadow canvas updates for perf improvement
const ZOOM2NODES_FACTOR = 4;

// Expose config from forceGraph
const bindFG = linkKapsule('forceGraph', CanvasForceGraph);
const bindBoth = linkKapsule(['forceGraph', 'shadowGraph'], CanvasForceGraph);
const linkedProps = Object.assign(
  ...[
    'nodeColor',
    'nodeAutoColorBy',
    'nodeCanvasObject',
    'linkColor',
    'linkAutoColorBy',
    'linkWidth',
    'linkDirectionalParticles',
    'linkDirectionalParticleSpeed',
    'linkDirectionalParticleWidth',
    'linkDirectionalParticleColor',
    'd3AlphaDecay',
    'd3VelocityDecay',
    'warmupTicks',
    'cooldownTicks',
    'cooldownTime'
  ].map(p => ({ [p]: bindFG.linkProp(p)})),
  ...[
    'nodeRelSize',
    'nodeId',
    'nodeVal',
    'linkSource',
    'linkTarget'
  ].map(p => ({ [p]: bindBoth.linkProp(p)}))
);
const linkedMethods = Object.assign(...[
  'd3Force'
].map(p => ({ [p]: bindFG.linkMethod(p)})));

function adjustCanvasSize(state) {
  if (state.canvas) {
    let curWidth = state.canvas.width;
    let curHeight = state.canvas.height;
    if (curWidth === 300 && curHeight === 150) { // Default canvas dimensions
      curWidth = curHeight = 0;
    }

    // Resize canvases
    [state.canvas, state.shadowCanvas].forEach(canvas => {
      canvas.width = state.width;
      canvas.height = state.height;
    });

    // Relative center panning based on 0,0
    const k = d3ZoomTransform(state.canvas).k;
    state.zoom.translateBy(state.zoom.__baseElem,
      (state.width - curWidth) / 2 / k,
      (state.height - curHeight) / 2 / k
    );
  }
}

//

export default Kapsule({
  props:{
    width: { default: window.innerWidth, onChange: (_, state) => adjustCanvasSize(state), triggerUpdate: false } ,
    height: { default: window.innerHeight, onChange: (_, state) => adjustCanvasSize(state), triggerUpdate: false },
    graphData: {
      default: { nodes: [], links: [] },
      onChange: ((d, state) => {
        if (d.nodes.length || d.links.length) {
          console.info('force-graph loading', d.nodes.length + ' nodes', d.links.length + ' links');
        }

        [{ type: 'Node', objs: d.nodes }, { type: 'Link', objs: d.links }].forEach(hexIndex);
        state.forceGraph.graphData(d);
        state.shadowGraph.graphData(d);

        function hexIndex({ type, objs }) {
          objs
            .filter(d => !d.hasOwnProperty('__indexColor'))
            .forEach(d => {
              // store object lookup color
              d.__indexColor = state.colorTracker.register({ type, d });
            });
        }
      }),
      triggerUpdate: false
    },
    backgroundColor: { onChange(color, state) { state.canvas && color && (state.canvas.style.background = color) }, triggerUpdate: false },
    nodeLabel: { default: 'name', triggerUpdate: false },
    linkLabel: { default: 'name', triggerUpdate: false },
    linkHoverPrecision: { default: 4, triggerUpdate: false },
    enablePointerInteraction: { default: true, onChange(_, state) { state.hoverObj = null; }, triggerUpdate: false },
    onNodeClick: { default: () => {}, triggerUpdate: false },
    onNodeHover: { default: () => {}, triggerUpdate: false },
    onLinkClick: { default: () => {}, triggerUpdate: false },
    onLinkHover: { default: () => {}, triggerUpdate: false },
    ...linkedProps
  },

  methods: {
    centerAt: function(state, x, y) {
      if (!state.canvas) return null; // no canvas yet
      const t = d3ZoomTransform(state.canvas);

      if (x !== undefined || y !== undefined) {
        state.zoom.translateTo(
          state.zoom.__baseElem,
          x === undefined ? t.x : x,
          y === undefined ? t.y : y
        );
        return this;
      }

      return { x: (state.width / 2 - t.x) / t.k, y: (state.height / 2 - t.y) / t.k };
    },
    zoom: function(state, k) {
      if (!state.canvas) return null; // no canvas yet

      if (k !== undefined) {
        state.zoom.scaleTo(state.zoom.__baseElem, k);
        return this;
      }

      return d3ZoomTransform(state.canvas).k;
    },
    stopAnimation: function(state) {
      if (state.animationFrameRequestId) {
        cancelAnimationFrame(state.animationFrameRequestId);
      }
      return this;
    },
    ...linkedMethods
  },

  stateInit: () => ({
    lastSetZoom: 1,
    forceGraph: new CanvasForceGraph(),
    shadowGraph: new CanvasForceGraph()
      .cooldownTicks(0)
      .nodeColor('__indexColor')
      .linkColor('__indexColor'),
    colorTracker: new ColorTracker() // indexed objects for rgb lookup
  }),

  init: function(domNode, state) {
    // Wipe DOM
    domNode.innerHTML = '';

    state.canvas = document.createElement('canvas');
    if (state.backgroundColor) state.canvas.style.background = state.backgroundColor;
    domNode.appendChild(state.canvas);

    state.shadowCanvas = document.createElement('canvas');

    // Show shadow canvas
    //state.shadowCanvas.style.position = 'absolute';
    //state.shadowCanvas.style.top = '0';
    //state.shadowCanvas.style.left = '0';
    //domNode.appendChild(state.shadowCanvas);

    const ctx = state.canvas.getContext('2d');
    const shadowCtx = state.shadowCanvas.getContext('2d');

    // Setup zoom / pan interaction
    state.zoom = d3Zoom();
    state.zoom(state.zoom.__baseElem = d3Select(state.canvas)); // Attach controlling elem for easy access

    state.zoom
      .scaleExtent([0.01, 1000])
      .on('zoom', function() {
        const t = d3ZoomTransform(this); // Same as d3.event.transform
        [ctx, shadowCtx].forEach(c => {
          c.resetTransform();
          c.translate(t.x, t.y);
          c.scale(t.k, t.k);
        });
      });

    adjustCanvasSize(state);

    state.forceGraph.onFinishLoading(() => {
      // re-zoom, if still in default position (not user modified)
      if (d3ZoomTransform(state.canvas).k === state.lastSetZoom) {
        state.zoom.scaleTo(state.zoom.__baseElem,
          state.lastSetZoom = ZOOM2NODES_FACTOR / Math.cbrt(state.forceGraph.graphData().nodes.length)
        );
      }
    });

    // Setup tooltip
    const toolTipElem = document.createElement('div');
    toolTipElem.classList.add('graph-tooltip');
    domNode.appendChild(toolTipElem);

    // Capture mouse coords on move
    const mousePos = { x: -Infinity, y: -Infinity };
    state.canvas.addEventListener("mousemove", ev => {
      // update the mouse pos
      const offset = getOffset(domNode);
      mousePos.x = ev.pageX - offset.left;
      mousePos.y = ev.pageY - offset.top;

      // Move tooltip
      toolTipElem.style.top = `${mousePos.y}px`;
      toolTipElem.style.left = `${mousePos.x}px`;

      //

      function getOffset(el) {
        const rect = el.getBoundingClientRect(),
          scrollLeft = window.pageXOffset || document.documentElement.scrollLeft,
          scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        return { top: rect.top + scrollTop, left: rect.left + scrollLeft };
      }
    }, false);

    // Handle click events on nodes
    domNode.addEventListener("click", ev => {
      if (state.hoverObj) {
        state[`on${state.hoverObj.type}Click`](state.hoverObj.d);
      }
    }, false);

    state.forceGraph(ctx);
    state.shadowGraph(shadowCtx);

    //

    const refreshShadowCanvas = throttle(() => {
      // wipe canvas
      const t = d3ZoomTransform(state.canvas);
      shadowCtx.clearRect(-t.x / t.k, -t.y / t.k, state.width / t.k, state.height / t.k);

      // Adjust link hover area
      state.shadowGraph.linkWidth(l => accessorFn(state.linkWidth)(l) + state.linkHoverPrecision);

      // redraw
      state.shadowGraph.globalScale(t.k).tickFrame();
    }, HOVER_CANVAS_THROTTLE_DELAY);

    // Kick-off renderer
    (function animate() { // IIFE
      if (state.enablePointerInteraction) {
        // Update tooltip and trigger onHover events

        // Lookup object per pixel color
        const obj = state.colorTracker.lookup(shadowCtx.getImageData(mousePos.x, mousePos.y, 1, 1).data);

        if (obj !== state.hoverObj) {
          const prevObj = state.hoverObj;
          const prevObjType = prevObj ? prevObj.type : null;
          const objType = obj ? obj.type : null;

          if (prevObjType && prevObjType !== objType) {
            // Hover out
            state[`on${prevObjType}Hover`](null, prevObj.d);
          }
          if (objType) {
            // Hover in
            state[`on${objType}Hover`](obj.d, prevObjType === objType ? prevObj.d : null);
          }

          const tooltipContent = obj ? accessorFn(state[`${obj.type.toLowerCase()}Label`])(obj.d) || '' : '';
          toolTipElem.style.visibility = tooltipContent ? 'visible' : 'hidden';
          toolTipElem.innerHTML = tooltipContent;

          state.hoverObj = obj;
        }

        refreshShadowCanvas();
      }

      // Wipe canvas
      const t = d3ZoomTransform(state.canvas);
      ctx.clearRect(-t.x / t.k, -t.y / t.k, state.width / t.k, state.height / t.k);

      // Frame cycle
      state.forceGraph.globalScale(t.k).tickFrame();

      state.animationFrameRequestId = requestAnimationFrame(animate);
    })();
  },

  update: function updateFn(state) {}
});
