/* Levels are data (the Studio Level DSL). The Level Design agent edits this file. */
window.LEVELS = [
  {
    name: 'Green Run', tile: 40, width: 1920, height: 540, groundY: 470, sky: 0x1d2b53,
    spawn: { x: 60, y: 360 }, goal: 1860,
    ground: [[0, 420, 'solid'], [560, 1100, 'solid'], [1180, 1920, 'solid']], // gaps: 420-560, 1100-1180
    walls: [{ x: 760, tiles: 2, mat: 'stone' }],
    coins: [{ x: 300, y: 440 }, { x: 360, y: 440 }, { x: 900, y: 440 }, { x: 1300, y: 440 }, { x: 1400, y: 440 }, { x: 1640, y: 360 }],
    enemies: [{ x: 980, patrol: 50 }]
  }
];
