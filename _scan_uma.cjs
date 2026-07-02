const fs = require('fs');
const d = JSON.parse(fs.readFileSync('/tmp/eslint.json', 'utf8'));
const ua = {}, ea = {};
let ut = 0, et = 0, uw = 0, ew = 0;
d.forEach(function(f) {
  f.messages.forEach(function(m) {
    if (m.ruleId === '@typescript-eslint/no-unsafe-member-access') {
      const p = f.filePath.replace(/\\/g, '/').replace(/^.*src\//, 'src/');
      if (m.severity === 2) { ua[p] = (ua[p] || 0) + 1; ut++; } else { uw++; }
    }
    if (m.ruleId === '@typescript-eslint/no-explicit-any') {
      const p = f.filePath.replace(/\\/g, '/').replace(/^.*src\//, 'src/');
      if (m.severity === 2) { ea[p] = (ea[p] || 0) + 1; et++; } else { ew++; }
    }
  });
});
console.log('unsafe-member-access ERROR: ' + ut + ', WARN: ' + uw);
console.log('explicit-any ERROR: ' + et + ', WARN: ' + ew);
console.log('\n=== unsafe-member-access ERRORS ===');
Object.entries(ua).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 20).forEach(function(e) { console.log(e[0] + '\t' + e[1]); });
console.log('\n=== explicit-any ERRORS ===');
Object.entries(ea).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 20).forEach(function(e) { console.log(e[0] + '\t' + e[1]); });
