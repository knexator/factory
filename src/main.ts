import * as twgl from "twgl.js"
import GUI from "lil-gui";
import { Grid2D } from "./kommon/grid2D";
import { Input, KeyCode, Mouse, MouseButton } from "./kommon/input";
import { DefaultMap, deepcopy, fromCount, fromRange, objectMap, repeat, zip2 } from "./kommon/kommon";
import { mod, towards as approach, lerp, inRange, clamp, argmax, argmin, max, remap, clamp01, randomInt, randomFloat, randomChoice } from "./kommon/math";
import { canvasFromAscii } from "./kommon/spritePS";
import { initGL2, IVec, Vec2, Color, GenericDrawer, StatefulDrawer, CircleDrawer, m3, CustomSpriteDrawer, Transform, IRect, IColor, IVec2, FullscreenShader } from "kanvas2d"
import GLPK from "glpk.js"

const glpk = await GLPK();
const input = new Input();
const canvas_ctx = document.querySelector<HTMLCanvasElement>("#ctx_canvas")!;
const ctx = canvas_ctx.getContext("2d")!;
const canvas_gl = document.querySelector<HTMLCanvasElement>("#gl_canvas")!;
const gl = initGL2(canvas_gl)!;
gl.clearColor(.5, .5, .5, 1);

type Ruleset = {
  items: [string, number][];
  fixed_recipes: [string, string][];
  user_recipes: [string, string][];
  fixed_factories: [number, Vec2][];
};

const rulesets: Record<string, Ruleset> = {
  POTATO: {
    items: [
      ['⭐', 10],
      ['💧', .1],
      ['🥔', 1],
      ['🍜', 2],
      ['🧪', .1],
      ['🚂🧪', .1],
    ],
    fixed_recipes: [
      ['⭐', ''],
      ['', '💧'],
      ['', '🥔'],
    ],
    user_recipes: [
      ['🍜', '⭐'],
      ['🥔,💧', '🍜'],
      ['🥔', '🧪'],
      ['🧪,💧,💧', '🍜'],
      ['🧪,🧪,🧪,🧪,🧪', '🚂🧪'],
      ['🚂🧪', '🧪,🧪,🧪,🧪,🧪'],
    ],
    fixed_factories: [
      [0, new Vec2(300, 0)],
      [1, new Vec2(-500, -100)],
      [2, new Vec2(-500, 100)],
    ]
  },
  FACTORIO_RED_GREEN: {
    // factorio gears are interesting because many recipes use gears & iron plates,
    // so even if it's cheaper to move gears than iron, it might not be cheaper to move gears & iron
    items: ([
      // name, factorio stack size
      ['🔴', 200], // red science
      ['🟢', 200], // green science

      ['🔥', 50], // coal

      ['🧱', 100], // copper plate
      ['⛏️🧱', 50], // copper ore

      ['🔩', 100], // iron plate
      ['⛏️🔩', 50], // iron ore

      ['⚙️', 100], // iron gear
      ['🔌', 200], // copper cable
      ['💾', 200], // green circuit
      ['🛴', 100], // transport belt
      ['🦾', 50], // inserter
    ] as [string, number][]).map(([str, stack]) => [str, 100 / stack] as [string, number]).flatMap(([name, cost]) => [[name, cost], [`📦${name}`, cost]]),

    fixed_recipes: [
      ['🔴', ''],
      ['🟢', ''],
      ['', '⛏️🔩'],
      ['', '⛏️🧱'],
      ['', '🔥'],
    ],
    user_recipes: [
      ['🔥,⛏️🔩', '🔩'],
      ['🔥,⛏️🧱', '🧱'],
      ['🔩,🔩', '⚙️'],
      ['🧱', '🔌,🔌'],
      ['🔌,🔌,🔌,🔩', '💾'],
      ['⚙️,🔩', '🛴,🛴'],
      ['💾,⚙️,🔩', '🦾'],

      ['🧱,⚙️', '🔴'],
      ['🛴,🦾', '🟢'],

      ...(['🔴', '🟢', '🔥', '🧱', '⛏️🧱', '🔩', '⛏️🔩', '⚙️', '🔌', '💾', '🛴', '🦾',]
        .flatMap(x => [[repeat(5, x).join(','), `📦${x}`], [`📦${x}`, repeat(5, x).join(',')]] as [string, string][])),
    ],
    fixed_factories: [
      ...fromCount(5, k => [0, new Vec2(k * 100, -50)]) as [number, Vec2][],
      ...fromCount(5, k => [1, new Vec2(k * 100, 50)]) as [number, Vec2][],
      [2, new Vec2(-1200, -300)],
      [3, new Vec2(-1200, 300)],
      [4, new Vec2(-1500, 0)],
      ...fromCount(5, k => [2, new Vec2(1500, -1000).add(Vec2.fromTurns(k / 5).scale(100))]) as [number, Vec2][],
      ...fromCount(5, k => [3, new Vec2(1500, 1000).add(Vec2.fromTurns(k / 5).scale(100))]) as [number, Vec2][],
    ]
  }
}

const CONFIG = {
  factory_size: 20,
  breathing_space_multiplier: 0,
  label_spacing: 40,
  auto_edges: true,
  editor_mode: false,
  max_production: 3,
  ruleset: "POTATO",
  randomize_start: () => randomizeMap(true),
  randomize_game: () => randomizeMap(false),
};

const gui = new GUI();
gui.add(CONFIG, "factory_size", 10, 50);
gui.add(CONFIG, "breathing_space_multiplier", 0, 5);
gui.add(CONFIG, "label_spacing", 10, 50);
gui.add(CONFIG, 'auto_edges');
gui.add(CONFIG, 'editor_mode');
gui.add(CONFIG, 'max_production', 1, 10);
gui.add(CONFIG, 'ruleset', Object.keys(rulesets)).onChange((name: string) => {
  setRuleset(rulesets[name]);
});
gui.add(CONFIG, 'randomize_start');
gui.add(CONFIG, 'randomize_game');

// current design:
// no throughput, no delays, 
// single goal factory

// TODO: move several factories at once?

class ItemKind {
  constructor(
    public name: string,
    // how long it takes to travel 10px
    public transport_cost: number,
    public id: number,
  ) { }

  toString(): string {
    return this.name;
    // return Object.entries(items).find(([_key, item]) => item === this)![0];
  }
};

class Recipe {
  constructor(
    public inputs: [number, ItemKind][],
    public outputs: [number, ItemKind][],
    // how many seconds between getting the inputs & generating the outputs // not really
    public cost: number,
  ) { }

  static build(cost: number, inputs_str: string, outputs_str: string): Recipe {
    let input_counts = new DefaultMap<string, number>(_ => 0);
    let output_counts = new DefaultMap<string, number>(_ => 0);
    if (inputs_str != '') inputs_str.split(',').forEach(name => input_counts.set(name, input_counts.get(name) + 1));
    if (outputs_str != '') outputs_str.split(',').forEach(name => output_counts.set(name, output_counts.get(name) + 1));

    return new Recipe(
      [...input_counts.inner_map.entries()].map(([name, count]) => {
        const item = single(items.filter(i => i.name === name));
        return [count, item];
      }),
      [...output_counts.inner_map.entries()].map(([name, count]) => {
        const item = single(items.filter(i => i.name === name));
        return [count, item];
      }),
      cost
    );
  }
}

const next_factory_id: () => number = (function () {
  let id = -1;
  return () => {
    id += 1;
    return id;
  }
})();

class RealFactory {
  public id: number;
  constructor(
    public pos: Vec2,
    public recipe: Recipe,
    public fixed: boolean,
    // public max_production: number,
    // how many copies of the recipe are processed each second // not really
    public production: number = 0,
  ) {
    this.id = next_factory_id();
  }
}

class StubFactory {
  public id: number;
  public recipe: 'stub' = 'stub';
  constructor(
    public pos: Vec2,
  ) {
    this.id = next_factory_id();
  }

  public get fixed(): boolean {
    return false
  }
}

type Factory = RealFactory | StubFactory;

class Edge {
  constructor(
    public source: Factory,
    public target: Factory,
    // how many items arrive per second // not really
    public traffic: [number, ItemKind][] = [],
  ) { }

  dist(): number {
    return this.source.pos.sub(this.target.pos).mag();
  }
}

let items: ItemKind[];
let fixed_recipes: Recipe[];
let user_recipes: Recipe[];
let factories: Factory[];
let edges: Edge[];

function setRuleset(ruleset: Ruleset): void {
  items = ruleset.items.map(([name, cost], k) => new ItemKind(name, cost, k));
  fixed_recipes = ruleset.fixed_recipes.map(([in_str, out_str]) => Recipe.build(out_str === '' ? -100_000 : 100, in_str, out_str));
  user_recipes = ruleset.user_recipes.map(([in_str, out_str]) => Recipe.build(100, in_str, out_str));
  factories = ruleset.fixed_factories.map(([recipe_index, pos]) => new RealFactory(pos, fixed_recipes[recipe_index], true));
  edges = [];
}

function commonItems(source: Factory, target: Factory): ItemKind[] {
  if (source.recipe === 'stub') {
    if (target.recipe === 'stub') {
      return items;
    } else {
      return target.recipe.inputs.map(([_, item]) => item);
    }
  } else {
    if (target.recipe === 'stub') {
      return source.recipe.outputs.map(([_, item]) => item);
    } else {
      const inbounds = source.recipe.outputs.map(([_, item]) => item);
      const outbounds = target.recipe.inputs.map(([_, item]) => item);
      return inbounds.filter(value => outbounds.includes(value));
    }
  }
}

setRuleset(rulesets[CONFIG.ruleset]);

function randomizeMap(only_fixed: boolean): void {
  if (only_fixed) {
    fromCount(3 * fixed_recipes.length, _ => {
      factories.push(new RealFactory(Vec2.fromTurns(Math.random()).scale(randomFloat(400, 2000)), fixed_recipes[randomInt(1, fixed_recipes.length)], true));
    });
  } else {
    fromCount(3 * fixed_recipes.length, _ => {
      factories.push(new RealFactory(Vec2.fromTurns(Math.random()).scale(randomFloat(400, 2000)), fixed_recipes[randomInt(1, fixed_recipes.length)], true));
    });
    fromCount(3 * user_recipes.length, _ => {
      factories.push(new RealFactory(Vec2.fromTurns(Math.random()).scale(randomFloat(400, 2000)), randomChoice(user_recipes), false));
    });
  }
  edges = [];
}

let master_profit = 0;
async function recalcEdgeWeightsAndFactoryProductions() {
  await recalcMaxProfit();
}

async function recalcMaxProfit() {
  if (CONFIG.auto_edges) {
    edges = [];
    factories.forEach(source => {
      factories.forEach(target => {
        if (source === target) return;
        const common = commonItems(source, target);
        if (common.length > 0) {
          edges.push(new Edge(source, target, common.map(c => [0, c])));
        }
      });
    });
  } else {
    edges.forEach(edge => {
      const common = commonItems(edge.source, edge.target);
      edge.traffic = common.map(item => [0, item]);
    });
  }
  const real_factories: RealFactory[] = factories.filter(x => x.recipe !== 'stub') as RealFactory[];
  real_factories.forEach(f => {
    f.production = 0;
  });
  const stub_factories: StubFactory[] = factories.filter(x => x.recipe === 'stub') as StubFactory[];

  const production_limits = real_factories.map(f => ({
    name: `maxproduction_${f.id}`,
    vars: [{ name: `production_${f.id}`, coef: 1 }],
    // bnds: { type: glpk.GLP_UP, ub: f.max_production, lb: 0 },
    bnds: { type: glpk.GLP_DB, ub: fixed_recipes.includes(f.recipe) ? 1 : CONFIG.max_production, lb: 0 },
  }));

  const result = (await glpk.solve({
    name: 'LP',
    objective: {
      direction: glpk.GLP_MAX,
      name: "profit",
      vars: [
        ...real_factories.map(f => ({ name: `production_${f.id}`, coef: -f.recipe.cost })),
        ...edges.flatMap((e, edge_id) => e.traffic.map(([_, item]) => {
          return { name: `transport_${edge_id}_${item.id}`, coef: -e.dist() * item.transport_cost };
        }))
      ],
    },
    subjectTo: [
      ...production_limits,
      ...real_factories.flatMap(f => {
        return f.recipe.inputs.map(([amount, item], _) => {
          let asdf: { name: string, coef: number }[] = [];
          edges.forEach((e, edge_id) => {
            if (e.target === f && e.traffic.some(([_, edge_item]) => edge_item === item)) {
              asdf.push({ name: `transport_${edge_id}_${item.id}`, coef: 1 });
            }
          });

          return {
            name: `balancein_${f.id}_${item.id}`,
            vars: [{ name: `production_${f.id}`, coef: -amount },
            ...asdf],
            bnds: { type: glpk.GLP_FX, ub: 0, lb: 0 }
          }
        })
      }),
      ...real_factories.flatMap(f => {
        return f.recipe.outputs.map(([amount, item], _) => {
          let asdf: { name: string, coef: number }[] = [];
          edges.forEach((e, edge_id) => {
            if (e.source === f && e.traffic.some(([_, edge_item]) => edge_item === item)) {
              asdf.push({ name: `transport_${edge_id}_${item.id}`, coef: 1 });
            }
          });

          return {
            name: `balanceout_${f.id}_${item.id}`,
            vars: [{ name: `production_${f.id}`, coef: -amount },
            ...asdf],
            bnds: { type: glpk.GLP_FX, ub: 0, lb: 0 }
          }
        })
      }),
      ...stub_factories.flatMap(f => {
        return items.map(item => {
          let asdf: { name: string, coef: number }[] = [];
          edges.forEach((e, edge_id) => {
            if (e.source === f && e.traffic.some(([_, edge_item]) => edge_item === item)) {
              asdf.push({ name: `transport_${edge_id}_${item.id}`, coef: -1 });
            }
            if (e.target === f && e.traffic.some(([_, edge_item]) => edge_item === item)) {
              asdf.push({ name: `transport_${edge_id}_${item.id}`, coef: 1 });
            }
          });
          return {
            name: `balancearound_${f.id}_${item.id}`,
            vars: asdf,
            bnds: { type: glpk.GLP_FX, ub: 0, lb: 0 }
          }
        }).filter(x => x.vars.length > 0);
      })
    ],
  })).result;

  master_profit = result.z;
  Object.entries(result.vars).forEach(([name, value]) => {
    if (name.startsWith('production')) {
      const factory_id = Number(name.split('_')[1]);
      const factory = factories[factory_id];
      if (factory.recipe === 'stub') throw new Error(`stub factory ${factory_id} has production ${value}`);
      factory.production = value;
    } else if (name.startsWith('transport')) {
      const [_, edge_id, item_id] = name.split('_');
      const edge = edges[Number(edge_id)];
      const traffic_index = edge.traffic.findIndex(([_, item]) => item.id === Number(item_id));
      edge.traffic[traffic_index][0] = value;
    } else {
      throw new Error();
    }
  });
}

const background_drawer = new FullscreenShader(gl, `#version 300 es
precision mediump float;
in vec2 v_uv;

// uv (0.5, 0.5) => u_camera_pos
// uv (0.0, 0.0) => u_camera_pos - u_camera_size / 2;
uniform vec2 u_camera_pos;
uniform vec2 u_camera_size;

/* discontinuous pseudorandom uniformly distributed in [-0.5, +0.5]^3 */
vec3 random3(vec3 c) {
	float j = 4096.0*sin(dot(c,vec3(17.0, 59.4, 15.0)));
	vec3 r;
	r.z = fract(512.0*j);
	j *= .125;
	r.x = fract(512.0*j);
	j *= .125;
	r.y = fract(512.0*j);
	return r-0.5;
}

/* skew constants for 3d simplex functions */
const float F3 =  0.3333333;
const float G3 =  0.1666667;

/* 3d simplex noise, -.5 to .5 */
float simplex3d(vec3 p) {
	 /* 1. find current tetrahedron T and it's four vertices */
	 /* s, s+i1, s+i2, s+1.0 - absolute skewed (integer) coordinates of T vertices */
	 /* x, x1, x2, x3 - unskewed coordinates of p relative to each of T vertices*/
	 
	 /* calculate s and x */
	 vec3 s = floor(p + dot(p, vec3(F3)));
	 vec3 x = p - s + dot(s, vec3(G3));
	 
	 /* calculate i1 and i2 */
	 vec3 e = step(vec3(0.0), x - x.yzx);
	 vec3 i1 = e*(1.0 - e.zxy);
	 vec3 i2 = 1.0 - e.zxy*(1.0 - e);
	 	
	 /* x1, x2, x3 */
	 vec3 x1 = x - i1 + G3;
	 vec3 x2 = x - i2 + 2.0*G3;
	 vec3 x3 = x - 1.0 + 3.0*G3;
	 
	 /* 2. find four surflets and store them in d */
	 vec4 w, d;
	 
	 /* calculate surflet weights */
	 w.x = dot(x, x);
	 w.y = dot(x1, x1);
	 w.z = dot(x2, x2);
	 w.w = dot(x3, x3);
	 
	 /* w fades from 0.6 at the center of the surflet to 0.0 at the margin */
	 w = max(0.6 - w, 0.0);
	 
	 /* calculate surflet components */
	 d.x = dot(random3(s), x);
	 d.y = dot(random3(s + i1), x1);
	 d.z = dot(random3(s + i2), x2);
	 d.w = dot(random3(s + 1.0), x3);
	 
	 /* multiply d by w^4 */
	 w *= w;
	 w *= w;
	 d *= w;
	 
	 /* 3. return the sum of the four surflets */
	 return dot(d, vec4(52.0)) * .75;
}

vec2 pong(vec2 value, float pong_value) {
    vec2 v = mod(value, pong_value * 2.0);
    return min(v, pong_value * 2.0 - v);
}

out vec4 out_color;
void main() {
  vec2 world_pos = ((v_uv - .5) * u_camera_size * vec2(-1,1)) + u_camera_pos;
  float noise = simplex3d(vec3(world_pos / 3000., .0));
  noise = floor(noise * 5.) / 5.;
  out_color = vec4(vec3(.5 + .1 * noise), 1.0);
}
`);

// an object at [camera.center] will be drawn on the center of the screen
let camera = { center: Vec2.zero };

let interaction_state: {
  tag: 'none',
} | {
  tag: 'hovering_factory',
  hovered_factory: Factory,
} | {
  tag: 'making_rail',
  source: Factory,
  target: Factory | null,
} | {
  tag: 'making_factory',
  pos: Vec2,
  recipe: Recipe | null,
} | {
  tag: 'moving_factory',
  factory: Factory,
} = { tag: 'none' };

let last_timestamp = 0;
// main loop; game logic lives here
function every_frame(cur_timestamp: number) {
  // in seconds
  let delta_time = (cur_timestamp - last_timestamp) / 1000;
  last_timestamp = cur_timestamp;
  input.startFrame();
  ctx.resetTransform();
  ctx.font = "20px Arial";
  ctx.textBaseline = "middle"
  ctx.clearRect(0, 0, canvas_ctx.width, canvas_ctx.height);
  // ctx.fillStyle = 'gray';
  // ctx.fillRect(0, 0, canvas_ctx.width, canvas_ctx.height);
  ctx.fillStyle = 'black';
  if (or(twgl.resizeCanvasToDisplaySize(canvas_ctx), twgl.resizeCanvasToDisplaySize(canvas_gl))) {
    // resizing stuff
    gl.viewport(0, 0, canvas_gl.width, canvas_gl.height);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  fillText(`Profit: ${master_profit}`, Vec2.zero);
  ctx.translate(camera.center.x + canvas_ctx.width / 2, camera.center.y + canvas_ctx.height / 2);
  ctx.textBaseline = 'middle';

  background_drawer.draw({
    u_camera_pos: camera.center.toArray(),
    u_camera_size: [canvas_gl.width, canvas_gl.height],
  });

  // logic
  const rect = canvas_ctx.getBoundingClientRect();
  const cur_mouse_pos = new Vec2(input.mouse.clientX - rect.left, input.mouse.clientY - rect.top).sub(camera.center).sub(new Vec2(canvas_ctx.width / 2, canvas_ctx.height / 2));
  const delta_mouse = new Vec2(input.mouse.clientX - input.mouse.prev_clientX, input.mouse.clientY - input.mouse.prev_clientY);
  let needs_recalc = false;

  const factory_under_mouse = factories.find(f => f.pos.sub(cur_mouse_pos).magSq() < CONFIG.factory_size * CONFIG.factory_size);
  switch (interaction_state.tag) {
    case 'none':
      if (input.mouse.isDown(MouseButton.Left) && !input.mouse.wasPressed(MouseButton.Left)) {
        // drag view with left mouse
        camera.center = camera.center.add(delta_mouse);
      } else if (factory_under_mouse) {
        // hover
        interaction_state = { tag: 'hovering_factory', hovered_factory: factory_under_mouse };
      } else if (input.mouse.wasPressed(MouseButton.Right)) {
        // create factory
        interaction_state = { tag: 'making_factory', pos: cur_mouse_pos, recipe: null };
      }
      break;
    case "hovering_factory":
      if (!factory_under_mouse) {
        interaction_state = { tag: 'none' };
      } else if (factory_under_mouse !== interaction_state.hovered_factory) {
        interaction_state.hovered_factory = factory_under_mouse;
      } else if (input.mouse.wasPressed(MouseButton.Right)) {
        interaction_state = { tag: 'making_rail', source: interaction_state.hovered_factory, target: null };
      } else if (input.mouse.wasPressed(MouseButton.Left) && !interaction_state.hovered_factory.fixed) {
        interaction_state = { tag: 'moving_factory', factory: interaction_state.hovered_factory };
      }
      break;
    case 'moving_factory':
      let new_pos = interaction_state.factory.pos.add(delta_mouse);
      if (isValidPos(new_pos, interaction_state.factory)) {
        interaction_state.factory.pos = interaction_state.factory.pos.add(delta_mouse);
        needs_recalc = true;
      }
      // new_pos = findValidPosClosestTo(new_pos, interaction_state.factory);
      if (input.mouse.wasReleased(MouseButton.Left)) {
        interaction_state = { tag: 'none' };
      }
      break;
    case "making_rail":
      interaction_state.target = factory_under_mouse ?? null;

      // ensure valid target
      // cant connect to itself
      if (interaction_state.target === interaction_state.source) interaction_state.target = null;
      // cant connect without a common input/output
      if (interaction_state.target !== null && commonItems(interaction_state.source, interaction_state.target).length === 0) {
        interaction_state.target = null;
      }
      // cant connect existing connection
      if (interaction_state.target && edges.some(({ source, target }) => {
        if (interaction_state.tag !== 'making_rail' || interaction_state.target === null) throw new Error();
        return interaction_state.source === source && interaction_state.target === target;
      })) interaction_state.target = null;

      if (input.mouse.wasReleased(MouseButton.Right)) {
        if (interaction_state.target !== null) {
          edges.push(new Edge(interaction_state.source, interaction_state.target));
          needs_recalc = true;
        } else {
          const new_stub = new StubFactory(cur_mouse_pos);
          factories.push(new_stub);
          edges.push(new Edge(interaction_state.source, new_stub));
          needs_recalc = true;
        }
        interaction_state = { tag: 'none' };
      }
      break;
    case "making_factory":
      interaction_state.recipe = null;
      Object.entries(CONFIG.editor_mode ? [...fixed_recipes, ...user_recipes] : user_recipes).forEach(([name, recipe], k) => {
        if (interaction_state.tag !== 'making_factory') throw new Error();
        const selected = inRange((cur_mouse_pos.y - interaction_state.pos.y) / CONFIG.label_spacing, k - .5, k + .5);
        {
          const in_str = resourcesToString(recipe.inputs);
          const out_str = resourcesToString(recipe.outputs);
          ctx.textAlign = 'center';
          ctx.textAlign = 'right';
          fillText(in_str, interaction_state.pos.add(new Vec2(-CONFIG.factory_size * 1.25, k * CONFIG.label_spacing)));
          ctx.textAlign = 'left';
          fillText(out_str, interaction_state.pos.add(new Vec2(CONFIG.factory_size * 1.25, k * CONFIG.label_spacing)));

          if (selected) {
            ctx.textAlign = 'center';
            fillText('->', interaction_state.pos.addY(k * CONFIG.label_spacing));
          }
        }
        // fillText(recipe.toString(), interaction_state.pos.add(new Vec2(selected ? 30 : 0, k * CONFIG.label_spacing)))
        // fillText(name, interaction_state.pos.add(new Vec2(selected ? 30 : 0, k * CONFIG.label_spacing)))
        if (selected) {
          interaction_state.recipe = recipe;
        }
      });
      if (input.mouse.wasReleased(MouseButton.Right)) {
        if (interaction_state.recipe !== null) {
          factories.push(new RealFactory(interaction_state.pos, interaction_state.recipe, false));
          needs_recalc = true;
        }
        interaction_state = { tag: 'none' };
      }
      break;
    default:
      break;
  }

  // draw

  if (false && !CONFIG.auto_edges) {
    ctx.strokeStyle = 'black';
    ctx.beginPath();
    edges.forEach((edge) => {
      moveTo(edge.source.pos);
      lineTo(edge.target.pos);
    });
    ctx.stroke();
  } else {
    edges.forEach((edge) => {
      if (edge.traffic.some(([amount, _]) => amount > 0)) {
        ctx.strokeStyle = 'black';
      } else {
        ctx.strokeStyle = '#686868';
      }
      ctx.beginPath();
      moveTo(edge.source.pos);
      lineTo(edge.target.pos);
      ctx.stroke();
    });
    ctx.strokeStyle = 'black';
  }

  ctx.beginPath();
  factories.forEach(fac => {
    drawCircle(fac.pos, (fac.recipe === 'stub' ? .5 : 1) * CONFIG.factory_size);
  })
  ctx.stroke();

  ctx.beginPath();
  factories.forEach(fac => {
    drawCircle(fac.pos, CONFIG.factory_size * (fac.recipe === 'stub' ? .5 : 1) * (
      (interaction_state.tag === 'hovering_factory' && fac === interaction_state.hovered_factory
        || interaction_state.tag === 'making_rail' && fac === interaction_state.target)
        ? .8 : .5));
  })
  ctx.fill();

  factories.forEach(fac => {
    if (fac.recipe === 'stub') return;
    const in_str = resourcesToString(fac.recipe.inputs);
    const out_str = resourcesToString(fac.recipe.outputs);
    ctx.textAlign = 'right';
    fillText(in_str, fac.pos.addX(-CONFIG.factory_size * 1.25));
    ctx.textAlign = 'left';
    fillText(out_str, fac.pos.addX(CONFIG.factory_size * 1.25));
  })

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  edges.forEach(edge => {
    const dist = edge.dist();
    edge.traffic.forEach(([amount, item]) => {
      if (amount === 0) return;

      for (let k = 0; k < 3 * amount; k++) {
        const pos = Vec2.lerp(edge.source.pos, edge.target.pos, mod(item.id / items.length + k / (3 * amount) + .05 * cur_timestamp / (item.transport_cost * dist), 1));
        fillText(item.name, pos);
      }

      // const items_in_transit = amount * item.transport_cost * dist / 100;
      // // console.log(items_in_transit);
      // for (let k = 0; k < items_in_transit; k++) {
      //   const pos = Vec2.lerp(edge.source.pos, edge.target.pos, mod((.05 * cur_timestamp + k * 1000) / (item.transport_cost * dist), 1));
      //   // const pos = Vec2.lerp(edge.source.pos, edge.target.pos, mod(.05 * cur_timestamp / (item.transport_cost * dist), 1));
      //   fillText(item.name, pos);
      // }

      // ctx.font = `${Math.round(amount) * 20}px Arial`;
      // const pos = Vec2.lerp(edge.source.pos, edge.target.pos, mod(.05 * cur_timestamp / (item.transport_cost * dist), 1));
      // fillText(item.name, pos);
    });
  });
  // ctx.font = "20px Arial";

  // if (interaction_state.tag === 'hovering_factory' && interaction_state.hovered_factory.recipe !== recipes[0]) {
  //   ctx.fillText(interaction_state.hovered_factory.recipe.toString(), interaction_state.hovered_factory.pos.x + CONFIG.factory_size * 1.25, interaction_state.hovered_factory.pos.y);
  // }

  if (interaction_state.tag === 'making_rail') {
    let target_pos = interaction_state.target?.pos ?? cur_mouse_pos;
    ctx.beginPath();
    moveTo(interaction_state.source.pos);
    lineTo(target_pos);
    ctx.stroke();
  }

  // fillText(`Cost: ${master_cost}`, master_factory.pos.addX(CONFIG.factory_size * 1.25));

  if (needs_recalc) {
    recalcEdgeWeightsAndFactoryProductions();
  }

  // debug
  if (input.keyboard.wasPressed(KeyCode.Space)) {
    factories.forEach((f, k) => {
      if (f.recipe === 'stub') {
        console.log(`Factory ${k}, stub`);
      } else {
        console.log(`Factory ${k}, ${resourcesToString(f.recipe.inputs)} -> ${resourcesToString(f.recipe.outputs)}, at ${f.production}`);
      }
    });
    edges.forEach((e, k) => {
      console.log(`Edge ${k}, ${factories.indexOf(e.source)} -> ${factories.indexOf(e.target)}:`);
      e.traffic.forEach(([amount, item]) => {
        console.log(`\t${item.toString()}: ${amount}`);
      });
    })
  }

  animation_id = requestAnimationFrame(every_frame);
}

////// library stuff

function single<T>(arr: T[]) {
  if (arr.length === 0) {
    throw new Error("the array was empty");
  } else if (arr.length > 1) {
    throw new Error(`the array had more than 1 element: ${arr}`);
  } else {
    return arr[0];
  }
}

function at<T>(arr: T[], index: number): T {
  if (arr.length === 0) throw new Error("can't call 'at' with empty array");
  return arr[mod(index, arr.length)];
}

function drawCircle(center: Vec2, radius: number) {
  ctx.moveTo(center.x + radius, center.y);
  ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI);
}

function moveTo(pos: Vec2) {
  ctx.moveTo(pos.x, pos.y);
}

function lineTo(pos: Vec2) {
  ctx.lineTo(pos.x, pos.y);
}

function fillText(text: string, pos: Vec2) {
  ctx.fillText(text, pos.x, pos.y);
}

function resourcesToString(resources: [number, ItemKind][]): string {
  return resources.map(([count, item]) => item.name.repeat(count)).join('');
}

function isValidPos(pos: Vec2, ignore_factory: Factory): boolean {
  let min_dist_sq = 2 * CONFIG.factory_size * CONFIG.breathing_space_multiplier;
  min_dist_sq *= min_dist_sq;
  return !factories.some(f => f !== ignore_factory && f.pos.sub(pos).magSq() < min_dist_sq);
}

if (import.meta.hot) {
  if (import.meta.hot.data.edges) {
    factories = import.meta.hot.data.factories;
    edges = import.meta.hot.data.edges;
    user_recipes = import.meta.hot.data.user_recipes;
    fixed_recipes = import.meta.hot.data.fixed_recipes;
    items = import.meta.hot.data.items;
  }

  import.meta.hot.accept();

  import.meta.hot.dispose((data) => {
    input.mouse.dispose();
    input.keyboard.dispose();
    cancelAnimationFrame(animation_id);
    gui.destroy();
    data.factories = factories;
    data.edges = edges;
    data.user_recipes = user_recipes;
    data.fixed_recipes = fixed_recipes;
    data.items = items;
  })
}

let animation_id: number;
const loading_screen_element = document.querySelector<HTMLDivElement>("#loading_screen")!;
if (loading_screen_element) {
  loading_screen_element.innerText = "Press to start!";
  document.addEventListener("pointerdown", _event => {
    loading_screen_element.style.opacity = "0";
    animation_id = requestAnimationFrame(every_frame);
  }, { once: true });
} else {
  animation_id = requestAnimationFrame(every_frame);
}

function or(a: boolean, b: boolean) {
  return a || b;
}

