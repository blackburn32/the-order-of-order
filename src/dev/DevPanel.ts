import Phaser from 'phaser';
import { DIE_LADDER, DieSides, makeDie } from '../systems/Dice';
import { getRun } from '../state/RunState';

const PRESET_COUNTS = [10, 100, 1000, 1500, 3000, 10000, 100000];

/**
 * Dev-only overlay (excluded from production builds via `import.meta.env.DEV`)
 * for setting the run's dice count/composition instantly, without having to
 * play through the shop — mainly for testing grid rendering at scale.
 * Plain HTML/DOM, not a Phaser GameObject: far simpler than wiring up
 * Phaser's DOM Element support for a handful of form controls that never
 * need to appear in the actual game.
 */
export function installDevPanel(game: Phaser.Game): void {
  if (!import.meta.env.DEV) return;

  const toggle = document.createElement('button');
  toggle.textContent = 'DEV ▾';
  toggle.style.cssText = `
    position: fixed; top: 8px; right: 8px; z-index: 1001;
    background: rgba(10,8,16,0.85); color: #e6c65a; border: 1px solid #c9a227;
    border-radius: 4px; padding: 4px 8px; font: 11px system-ui, sans-serif; cursor: pointer;
  `;
  document.body.appendChild(toggle);

  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed; top: 36px; right: 8px; z-index: 1000; width: 220px;
    background: rgba(10,8,16,0.92); color: #e9d8a6; font: 12px/1.4 system-ui, sans-serif;
    border: 1px solid #c9a227; border-radius: 6px; padding: 8px 10px;
  `;
  panel.innerHTML = `
    <h4 style="margin:0 0 6px;font-size:12px;color:#e6c65a;">Dice Setup</h4>
    <label style="display:block;margin-top:6px;font-size:11px;opacity:.85;">Dice count</label>
    <input id="dp-count" type="number" min="0" max="1000000" value="6"
      style="width:100%;box-sizing:border-box;margin-top:2px;background:#1a1526;color:#e9d8a6;
             border:1px solid #5a4a2e;border-radius:3px;padding:3px 5px;font:inherit;" />
    <div id="dp-presets" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;"></div>
    <label style="display:block;margin-top:8px;font-size:11px;opacity:.85;">Die type</label>
    <select id="dp-type"
      style="width:100%;box-sizing:border-box;margin-top:2px;background:#1a1526;color:#e9d8a6;
             border:1px solid #5a4a2e;border-radius:3px;padding:3px 5px;font:inherit;">
      <option value="mixed">Mixed (cycle all types)</option>
      <option value="random">Random per die</option>
      ${DIE_LADDER.map((s) => `<option value="${s}">d${s}</option>`).join('')}
      <option value="20rp">d20 (Rollplayer)</option>
    </select>
    <button id="dp-apply" style="margin-top:8px;width:100%;padding:5px;background:#8a1f2b;
      color:#e9d8a6;border:none;border-radius:3px;cursor:pointer;font:inherit;font-weight:bold;">
      Apply
    </button>
    <div id="dp-status" style="margin-top:6px;font-size:11px;opacity:.75;"></div>
  `;
  document.body.appendChild(panel);

  const presetsEl = panel.querySelector('#dp-presets') as HTMLDivElement;
  const countInput = panel.querySelector('#dp-count') as HTMLInputElement;
  const typeSelect = panel.querySelector('#dp-type') as HTMLSelectElement;
  const status = panel.querySelector('#dp-status') as HTMLDivElement;

  for (const n of PRESET_COUNTS) {
    const b = document.createElement('button');
    b.textContent = String(n);
    b.style.cssText = `
      flex: 1 1 auto; padding: 3px 6px; background: #3a3050; color: #e9d8a6;
      border: none; border-radius: 3px; cursor: pointer; font: 11px inherit;
    `;
    b.onclick = () => {
      countInput.value = String(n);
    };
    presetsEl.appendChild(b);
  }

  typeSelect.value = '6';

  panel.querySelector('#dp-apply')!.addEventListener('click', () => {
    const count = Math.max(0, Math.floor(Number(countInput.value) || 0));
    applyDiceSetup(game, count, typeSelect.value);
    status.textContent = `Set ${count} dice (${typeSelect.options[typeSelect.selectedIndex].text}).`;
  });

  let visible = true;
  const applyVisibility = () => {
    panel.style.display = visible ? 'block' : 'none';
    toggle.textContent = visible ? 'DEV ▾' : 'DEV ▸';
  };
  toggle.onclick = () => {
    visible = !visible;
    applyVisibility();
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === '`') {
      visible = !visible;
      applyVisibility();
    }
  });
}

function applyDiceSetup(game: Phaser.Game, count: number, type: string): void {
  const state = getRun(game.registry);

  const dice = [];
  for (let i = 0; i < count; i++) {
    let sides: DieSides;
    let rollplayer = false;
    if (type === 'mixed') {
      sides = DIE_LADDER[i % DIE_LADDER.length];
    } else if (type === 'random') {
      sides = DIE_LADDER[Math.floor(Math.random() * DIE_LADDER.length)];
    } else if (type === '20rp') {
      sides = 20;
      rollplayer = true;
    } else {
      sides = Number(type) as DieSides;
    }
    dice.push(makeDie(sides, rollplayer));
  }
  state.dice = dice;
  game.registry.set('run', state);

  const active = game.scene.getScenes(true)[0];
  if (active && (active.scene.key === 'Game' || active.scene.key === 'Shop')) {
    active.scene.restart();
  }
}
