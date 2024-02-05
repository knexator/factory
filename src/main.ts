import * as twgl from "twgl.js"
import GUI from "lil-gui";
import { Grid2D } from "./kommon/grid2D";
import { Input, KeyCode, Mouse, MouseButton } from "./kommon/input";
import { DefaultMap, deepcopy, fromCount, objectMap, zip2 } from "./kommon/kommon";
import { mod, towards as approach, lerp, inRange, clamp, argmax, argmin, max, remap, clamp01 } from "./kommon/math";
import { canvasFromAscii } from "./kommon/spritePS";
import { initGL2, IVec, Vec2, Color, GenericDrawer, StatefulDrawer, CircleDrawer, m3, CustomSpriteDrawer, Transform, IRect, IColor, IVec2 } from "kanvas2d"

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
    public transport_cost: number,
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
    public cost: number,
  ) { }

  toString(): string {
    const inputs = this.inputs.map(([amount, kind]) => amount === 1 ? kind.toString() : `${amount} ${kind.toString()}`).join(', ');
    const outputs = this.outputs.map(([amount, kind]) => amount === 1 ? kind.toString() : `${amount} ${kind.toString()}`).join(', ');
    return `${inputs} => ${outputs}, cost ${this.cost}`;
    // return Object.entries(recipes).find(([_key, recipe]) => recipe === this)![0];
  }

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
    public production: number = 0,
  ) { }
}

class Edge {
  constructor(
    public source: Factory,
    public target: Factory,
    public traffic: [number, ItemKind][] = [],
  ) { }

  dist(): number {
    return this.source.pos.sub(this.target.pos).mag();
  }
}

let items = [
  new ItemKind('⭐', 10),
  new ItemKind('💧', .1),
  new ItemKind('🥔', 1),
  new ItemKind('🍜', 2),
  new ItemKind('🧪', .1),
];


let fixed_recipes = [
  Recipe.build(100, '⭐', ''),
  Recipe.build(100, '', '💧'),
  Recipe.build(100, '', '🥔'),
];

let user_recipes = [
  Recipe.build(100, '🥔', '🧪'),
  Recipe.build(100, '🥔💧', '🍜'),
  Recipe.build(100, '🧪💧💧', '🍜'),
  Recipe.build(100, '🍜', '⭐'),
];

let factories: Factory[] = [
  new Factory(new Vec2(300, 0), fixed_recipes[0], true),
  new Factory(new Vec2(-500, -100), fixed_recipes[1], true),
  new Factory(new Vec2(-500, 100), fixed_recipes[2], true),
];

let master_factory = factories[0];
let master_item = items[0];

let edges: Edge[] = [];

// function computeScore(): number {
//   return costOfOutput(single(factories.filter(x => x.recipe === recipes.score)));
// }

// TODO: we assume no cycles
// TODO: we assume 1 output per recipe & 1 input per ingredient
// TODO: we are assuming all outputs get consumed, don't do this
// TODO: let user solve the optimization problem?
function costOfOutput(factory: Factory): number {
  const input_factories = edges.filter(({ target }) => target === factory).map(({ source }) => ({ source, cost: costOfOutput(source) }));
  let total_cost = factory.recipe.cost;

  // const inputs = input_factories.flatMap(({producing_factory}) => producing_factory.recipe.outputs.map(([produced_amount, produced_item]) => (
  //   {producing_factory, produced_amount, produced_item}
  // )));
  // const valid_in = input_factories.filter(({ source }) => source.recipe.outputs.some(([_amnt, out]) => out === item));
  factory.recipe.inputs.forEach(([required_amount, required_item]) => {
    let min_cost = Infinity;
    input_factories.forEach(({ source, cost }) => {
      source.recipe.outputs.forEach(([produced_amount, produced_item]) => {
        if (produced_item !== required_item) return;
        const production_cost = cost * required_amount / produced_amount;
        const transport_cost = required_amount * required_item.transport_cost * (source.pos.sub(factory.pos).mag());
        const cur_cost = production_cost + transport_cost;
        if (cur_cost < min_cost) {
          min_cost = cur_cost;
        }
      })
    });
    total_cost += min_cost;
  });
  return total_cost;
}

function computeScore(): number {
  let cost = 0;
  factories.forEach(f => {
    cost += f.recipe.cost * f.production;
  });
  edges.forEach(e => {
    const dist = e.dist();
    e.traffic.forEach(([amount, item]) => {
      cost += dist * amount * item.transport_cost;
    });
  });
  if (master_factory.production === 0) return Infinity;
  return cost / master_factory.production;

  // const final_edges = edges.filter(x => x.target === master_factory);
  // if (final_edges.length === 0) return Infinity;
  // return final_edges.reduce((acc, edge) => acc + (edge.traffic.find(([_value, item]) => item === master_item)!)[0], 0);
}

function recalEdgeWeightsAndFactoryProductions() {
  // TODO: everything
  edges.forEach(edge => {
    edge.traffic = deepcopy(edge.source.recipe.outputs)
  });
  factories.forEach(f => {
    f.production = 1;
  });
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
          const in_str = recipe.inputs.map(([count, kind]) => kind.name.repeat(count)).join('');
          const out_str = recipe.outputs.map(([count, kind]) => kind.name.repeat(count)).join('');
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
    const in_str = fac.recipe.inputs.map(([count, kind]) => kind.name.repeat(count)).join('');
    const out_str = fac.recipe.outputs.map(([count, kind]) => kind.name.repeat(count)).join('');
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
      ctx.font = `${Math.round(amount) * 20}px Arial`;
      const pos = Vec2.lerp(edge.source.pos, edge.target.pos, mod(.05 * cur_timestamp / (item.transport_cost * dist), 1));
      fillText(item.name, pos);
    });
  });
  ctx.font = "20px Arial";

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
  recalEdgeWeightsAndFactoryProductions();
  fillText(`Cost of producing one score unit: ${computeScore()}`, master_factory.pos.addX(CONFIG.factory_size * 1.25));
  fillText(`other Cost of producing one score unit: ${costOfOutput(master_factory)}`, master_factory.pos.addX(CONFIG.factory_size * 1.25).addY(CONFIG.label_spacing));

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

if (import.meta.hot) {
  if (import.meta.hot.data.edges) {
    factories = import.meta.hot.data.factories;
    master_factory = factories[0];
    edges = import.meta.hot.data.edges;
    user_recipes = import.meta.hot.data.user_recipes;
    fixed_recipes = import.meta.hot.data.fixed_recipes;
    items = import.meta.hot.data.items;
    master_item = items[0];
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

