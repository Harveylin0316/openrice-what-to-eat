// Sanity check：用新 DB 跑 backend 的 recommendation 邏輯
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { recommendRestaurants, getFilterOptions } = require('../backend/utils/recommendation');

console.log('=== Sanity Check: 新 DB 與推薦邏輯相容性 ===\n');

// Test 1: 無篩選 → 隨機推薦 5 間
console.log('Test 1: 無篩選 (limit=5)');
const r1 = recommendRestaurants({}, 5);
console.log(`  返回 ${r1.length} 間`);
r1.forEach(r => console.log(`   - [${r.city||'?'}/${r.district||'?'}] ${r.name}  budget=${r.budget||'?'}  cuisines=${(r.cuisine_style||[]).join('/')}`));

// Test 2: 篩選 cuisine_style = 日式料理
console.log('\nTest 2: cuisine_style=日式料理 (limit=3)');
const r2 = recommendRestaurants({cuisine_style: ['日式料理']}, 3);
console.log(`  返回 ${r2.length} 間`);
r2.forEach(r => console.log(`   - ${r.name}  cuisines=${(r.cuisine_style||[]).join('/')}`));

// Test 3: 篩選 type=燒肉
console.log('\nTest 3: type=燒肉 (limit=3)');
const r3 = recommendRestaurants({type: ['燒肉']}, 3);
console.log(`  返回 ${r3.length} 間`);
r3.forEach(r => console.log(`   - ${r.name}  type=${(r.type||[]).join('/')}`));

// Test 4: 篩選 city=台北市
console.log('\nTest 4: city=台北市 (limit=3)');
const r4 = recommendRestaurants({city: '台北市'}, 3);
console.log(`  返回 ${r4.length} 間`);
r4.forEach(r => console.log(`   - [${r.city}/${r.district}] ${r.name}`));

// Test 5: getFilterOptions
console.log('\nTest 5: getFilterOptions()');
const opts = getFilterOptions();
console.log(`  cuisine_style 選項: ${(opts.cuisine_style || []).slice(0, 5).join(', ')}... (共 ${(opts.cuisine_style||[]).length})`);
console.log(`  type 選項: ${(opts.type || []).slice(0, 5).join(', ')}... (共 ${(opts.type||[]).length})`);
console.log(`  budget 選項: ${(opts.budget || []).join(', ')}`);

// Test 6: 確認 173 間 needs_scrape 不會影響
const all = recommendRestaurants({}, 1000);
const needs_scrape_in_result = all.filter(r => r.needs_scrape);
console.log(`\nTest 6: needs_scrape=true 餐廳在無篩選的推薦池: ${needs_scrape_in_result.length} 間`);
console.log(`  (這些店 cuisine/type 是空陣列，篩選有條件時不會被推薦)`);

console.log('\n=== 完成 ===');
