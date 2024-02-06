import * as twgl from "twgl.js"
import GUI from "lil-gui";
import { Grid2D } from "./kommon/grid2D";
import { Input, KeyCode, Mouse, MouseButton } from "./kommon/input";
import { DefaultMap, deepcopy, fromCount, objectMap, zip2 } from "./kommon/kommon";
import { mod, towards as approach, lerp, inRange, clamp, argmax, argmin, max, remap, clamp01 } from "./kommon/math";
import { canvasFromAscii } from "./kommon/spritePS";
import { initGL2, IVec, Vec2, Color, GenericDrawer, StatefulDrawer, CircleDrawer, m3, CustomSpriteDrawer, Transform, IRect, IColor, IVec2 } from "kanvas2d"
import GLPK from "glpk.js"

const glpk = await GLPK();
const input = new Input();
const canvas = document.querySelector("canvas")!;
const ctx = canvas.getContext("2d")!;

const CONFIG = {
  factory_size: 20,
  label_spacing: 40,
};

const gui = new GUI();
gui.add(CONFIG, "factory_size", 10, 50);
gui.add(CONFIG, "label_spacing", 10, 50);

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
    [...inputs_str].forEach(name => input_counts.set(name, input_counts.get(name) + 1));
    [...outputs_str].forEach(name => output_counts.set(name, output_counts.get(name) + 1));

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

class Factory {
  constructor(
    public pos: Vec2,
    public recipe: Recipe,
    public fixed: boolean,
    // how many copies of the recipe are processed each second // not really
    public production: number = 0,
  ) { }
}

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

// MASHED POTATO
let items = [
  new ItemKind('⭐', 10, 0),
  new ItemKind('💧', .1, 1),
  new ItemKind('🥔', 1, 2),
  new ItemKind('🍜', 2, 3),
  new ItemKind('🧪', .1, 4),
  new ItemKind('🚂', .1, 5),
];


let fixed_recipes = [
  Recipe.build(100, '⭐', ''),
  Recipe.build(100, '', '💧'),
  Recipe.build(100, '', '🥔'),
];

let user_recipes = [
  Recipe.build(100, '🍜', '⭐'),
  Recipe.build(100, '🥔💧', '🍜'),
  Recipe.build(100, '🥔', '🧪'),
  Recipe.build(100, '🧪💧💧', '🍜'),
  Recipe.build(100, '🧪🧪🧪🧪🧪', '🚂🧪'),
  Recipe.build(100, '🚂🧪', '🧪🧪🧪🧪🧪'),
];

let factories: Factory[] = [
  new Factory(new Vec2(300, 0), fixed_recipes[0], true),
  new Factory(new Vec2(-500, -100), fixed_recipes[1], true),
  new Factory(new Vec2(-500, 100), fixed_recipes[2], true),
];


// RED SCIENCE
// let items = [
//   new ItemKind('🔴', 100 / 200, 0),
//   new ItemKind(' 🧡', 100 / 100, 1),
//   new ItemKind('⛏️🧱', 1, 2),
//   new ItemKind('🍜', 2, 3),
//   new ItemKind('🧪', .1, 4),
// ];
// 🧱🔩
// 🔌⚙️


// let fixed_recipes = [
//   Recipe.build(100, '⭐', ''),
//   Recipe.build(100, '', '💧'),
//   Recipe.build(100, '', '🥔'),
// ];

// let user_recipes = [
//   Recipe.build(100, '🥔', '🧪'),
//   Recipe.build(100, '🥔 💧', '🍜'),
//   Recipe.build(100, '🧪 💧 💧', '🍜'),
//   Recipe.build(100, '🍜', '⭐'),
// ];

// let factories: Factory[] = [
//   new Factory(new Vec2(300, 0), fixed_recipes[0], true),
//   new Factory(new Vec2(-500, -100), fixed_recipes[1], true),
//   new Factory(new Vec2(-500, 100), fixed_recipes[2], true),
// ];

let edges: Edge[] = [];

let master_factory = factories[0];
let master_cost = Infinity;
async function recalEdgeWeightsAndFactoryProductions() {

  function allZero() {
    edges.forEach(edge => {
      edge.traffic = [];
    });
    factories.forEach(f => {
      f.production = 0;
    });
  }

  edges.forEach(edge => {
    const inputs = edge.source.recipe.outputs.map(([_, item]) => item);
    const outputs = edge.target.recipe.inputs.map(([_, item]) => item);
    edge.traffic = inputs.filter(value => outputs.includes(value)).map(value => {
      return [0, value];
    });
  });
  factories.forEach(f => {
    f.production = 0;
  });

  const result = (await glpk.solve({
    name: 'LP',
    objective: {
      direction: glpk.GLP_MIN,
      name: "cost",
      vars: [
        ...factories.map((f, factory_id) => ({ name: `production_${factory_id}`, coef: f.recipe.cost })),
        ...edges.flatMap((e, edge_id) => e.traffic.map(([_, item]) => {
          return { name: `transport_${edge_id}_${item.id}`, coef: e.dist() * item.transport_cost };
        }))
      ],
    },
    subjectTo: [
      {
        name: 'final',
        vars: [
          { name: 'production_0', coef: 1 }
        ],
        bnds: { type: glpk.GLP_FX, ub: 1, lb: 1 }
      },
      ...factories.flatMap((f, factory_id) => {
        return f.recipe.inputs.map(([amount, item], _) => {
          let asdf: { name: string, coef: number }[] = [];
          edges.forEach((e, edge_id) => {
            if (e.target === f && e.traffic.some(([_, edge_item]) => edge_item === item)) {
              asdf.push({ name: `transport_${edge_id}_${item.id}`, coef: 1 });
            }
          });

          return {
            name: `balancein_${factory_id}_${item.id}`,
            vars: [{ name: `production_${factory_id}`, coef: -amount },
            ...asdf],
            bnds: { type: glpk.GLP_FX, ub: 0, lb: 0 }
          }
        })
      }),
      ...factories.flatMap((f, factory_id) => {
        return f.recipe.outputs.map(([amount, item], _) => {
          let asdf: { name: string, coef: number }[] = [];
          edges.forEach((e, edge_id) => {
            if (e.source === f && e.traffic.some(([_, edge_item]) => edge_item === item)) {
              asdf.push({ name: `transport_${edge_id}_${item.id}`, coef: 1 });
            }
          });

          return {
            name: `balanceout_${factory_id}_${item.id}`,
            vars: [{ name: `production_${factory_id}`, coef: -amount },
            ...asdf],
            bnds: { type: glpk.GLP_FX, ub: 0, lb: 0 }
          }
        })
      }),
    ],
  })).result;

  if (result.status !== 5) {
    master_cost = Infinity;
    allZero();
  } else {
    master_cost = result.z;
    Object.entries(result.vars).forEach(([name, value]) => {
      if (name.startsWith('production')) {
        const factory_id = Number(name.split('_')[1]);
        factories[factory_id].production = value;
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
}

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
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'gray';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';
  if (twgl.resizeCanvasToDisplaySize(canvas)) {
    // resizing stuff
  }
  ctx.translate(camera.center.x + canvas.width / 2, camera.center.y + canvas.height / 2);

  // logic
  const rect = canvas.getBoundingClientRect();
  const cur_mouse_pos = new Vec2(input.mouse.clientX - rect.left, input.mouse.clientY - rect.top).sub(camera.center).sub(new Vec2(canvas.width / 2, canvas.height / 2));
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
      interaction_state.factory.pos = interaction_state.factory.pos.add(delta_mouse);
      needs_recalc = true;
      if (input.mouse.wasReleased(MouseButton.Left)) {
        interaction_state = { tag: 'none' };
      }
      break;
    case "making_rail":
      interaction_state.target = factory_under_mouse ?? null;

      // ensure valid target
      if (interaction_state.target === interaction_state.source) interaction_state.target = null;
      if (interaction_state.target !== null &&
        !interaction_state.source.recipe.outputs.some(([_, in_kind]) => {
          if (interaction_state.tag !== 'making_rail' || interaction_state.target === null) throw new Error();
          return interaction_state.target.recipe.inputs.some(([_, out_kind]) => in_kind === out_kind);
        })) interaction_state.target = null;
      if (interaction_state.target && edges.some(({ source, target }) => {
        if (interaction_state.tag !== 'making_rail' || interaction_state.target === null) throw new Error();
        return interaction_state.source === source && interaction_state.target === target;
      })) interaction_state.target = null;

      if (input.mouse.wasReleased(MouseButton.Right)) {
        if (interaction_state.target !== null) {
          edges.push(new Edge(interaction_state.source, interaction_state.target));
          needs_recalc = true;
        }
        interaction_state = { tag: 'none' };
      }
      break;
    case "making_factory":
      interaction_state.recipe = null;
      Object.entries(user_recipes).forEach(([name, recipe], k) => {
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
          factories.push(new Factory(interaction_state.pos, interaction_state.recipe, false));
        }
        interaction_state = { tag: 'none' };
      }
      break;
    default:
      break;
  }

  // draw

  ctx.beginPath();
  factories.forEach(fac => {
    drawCircle(fac.pos, CONFIG.factory_size);
  })
  ctx.stroke();

  ctx.beginPath();
  factories.forEach(fac => {
    drawCircle(fac.pos, CONFIG.factory_size * (
      (interaction_state.tag === 'hovering_factory' && fac === interaction_state.hovered_factory
        || interaction_state.tag === 'making_rail' && fac === interaction_state.target)
        ? .8 : .5));
  })
  ctx.fill();

  factories.forEach(fac => {
    const in_str = resourcesToString(fac.recipe.inputs);
    const out_str = resourcesToString(fac.recipe.outputs);
    ctx.textAlign = 'right';
    fillText(in_str, fac.pos.addX(-CONFIG.factory_size * 1.25));
    ctx.textAlign = 'left';
    fillText(out_str, fac.pos.addX(CONFIG.factory_size * 1.25));
  })

  ctx.beginPath();
  edges.forEach(({ source, target }) => {
    moveTo(source.pos);
    lineTo(target.pos);
  });
  ctx.stroke();

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

  ctx.textAlign = 'left';
  fillText(`Cost: ${master_cost}`, master_factory.pos.addX(CONFIG.factory_size * 1.25));

  if (needs_recalc) {
    recalEdgeWeightsAndFactoryProductions();
  }

  // debug
  if (input.keyboard.wasPressed(KeyCode.Space)) {
    factories.forEach((f, k) => {
      console.log(`Factory ${k}, ${resourcesToString(f.recipe.inputs)} -> ${resourcesToString(f.recipe.outputs)}, at ${f.production}`);
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

if (import.meta.hot) {
  if (import.meta.hot.data.edges) {
    factories = import.meta.hot.data.factories;
    master_factory = factories[0];
    edges = import.meta.hot.data.edges;
    user_recipes = import.meta.hot.data.user_recipes;
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

