import importlib.util, sys, time
_saved = sys.argv; sys.argv = ['x']
spec = importlib.util.spec_from_file_location("tt", "scripts/transfer-test.py")
tt = importlib.util.module_from_spec(spec); spec.loader.exec_module(tt)
sys.argv = _saved
for t in tt.http_json(tt.CDP + "/json/list"):
    if t["type"] == "page": tt.close_tab(t["id"])
time.sleep(1)
tab = tt.open_tab("http://127.0.0.1:8099/")
p = tt.Page(tab["id"]); p.call("Runtime.enable"); time.sleep(3)
r = p.ev("""(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) { try { indexedDB.deleteDatabase(d.name); } catch(e){} }
  localStorage.clear();
  return 'cleared:' + dbs.map(x=>x.name).join(',');
})()""")
print(r)
tt.close_tab(tab["id"])
