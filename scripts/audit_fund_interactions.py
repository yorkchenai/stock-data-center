"""Measure the application's HTTP path using real responses captured in this run."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import os
import subprocess
from threading import Barrier, Lock, Thread
from time import perf_counter, sleep
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import ProxyHandler, build_opener

from stock_analysis import funds
from stock_analysis.web import make_server


def measure_interactions(root, catalog_body, histories, browser_fixture):
    codes = list(histories)
    if not catalog_body or len(codes)<10:
        return {"status":"insufficient_real_inputs"}
    count = Counter()
    calls = Lock()
    fault_code = "999990"
    malformed = "999991"
    mismatch = "999992"

    def replay(url):
        key = "catalog" if url == funds.CATALOG_URL else url.rsplit("/",1)[-1].removesuffix(".js")
        with calls:
            count[key] += 1
        if key == "catalog":
            return catalog_body
        if key == fault_code:
            raise TimeoutError()
        if key == malformed:
            return 'var fS_code="999991";var fS_name="诊断输入";var Data_netWorthTrend=[{}];'
        if key == mismatch:
            return histories[codes[0]]
        if key in histories:
            sleep(.18)  # Ensure simultaneous clients overlap the underlying call.
            return histories[key]
        raise AssertionError(f"Unexpected upstream request: {key}")

    with patch("stock_analysis.funds.download",side_effect=replay):
        funds.catalog_for_day.cache_clear()
        server = make_server(port=0)
        worker = Thread(target=server.serve_forever,daemon=True)
        worker.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            def fetch(resource):
                started = perf_counter()
                client = build_opener(ProxyHandler({}))
                try:
                    with client.open(origin+"/api/funds/"+resource,timeout=10) as response:
                        status,payload = response.status,json.load(response)
                except HTTPError as error:
                    status,payload = error.code,json.load(error)
                actual = payload.get("code") or next(iter(payload.get("funds",[])),{}).get("code")
                return {"status":status,"returned_code":actual,"ms":round((perf_counter()-started)*1000,2)}

            search = [fetch("search?q="+quote(code)) for code in codes[:10]]
            after_search = count["catalog"]
            with ThreadPoolExecutor(max_workers=5) as executor:
                multi = list(executor.map(fetch,codes[:5]))
                gate = Barrier(5)

                def same(_):
                    gate.wait(timeout=4)
                    return fetch(codes[0])

                previous = count[codes[0]]
                repeated = list(executor.map(same,range(5)))
                deduplicated = count[codes[0]] - previous
            previous = count[codes[0]]
            later = [fetch(codes[0]),fetch(codes[0])]
            new_fetches = count[codes[0]] - previous
            errors = {name:fetch(code)["status"]
                      for name,code in [("injected_timeout",fault_code),("malformed_nav",malformed),("wrong_code",mismatch)]}
            identities = (
                [item["returned_code"] for item in search]==codes[:10]
                and [item["returned_code"] for item in multi]==codes[:5]
                and all(item["returned_code"]==codes[0] for item in repeated+later)
            )
            assert identities and all(item["status"]==200 for item in search+multi+repeated+later)
            assert after_search==1 and deduplicated==1 and new_fetches==2
            assert errors=={"injected_timeout":502,"malformed_nav":422,"wrong_code":422}
            result = {"status":"pass","method":"loopback HTTP with captured real upstream responses and 180 ms replay delay",
                      "searches":search,"catalog_fetches_for_10_searches":after_search,
                      "parallel_5_distinct":multi,"parallel_5_same":repeated,"same_code_upstream_requests":deduplicated,
                      "sequential_2_same":later,"sequential_upstream_requests":new_fetches,"fault_status":errors}
            if browser_fixture and os.environ.get("CHROMIUM_PATH"):
                browser_input = {"origin":origin,"fixtures":browser_fixture}
                call = subprocess.run(["node","scripts/audit_fund_interactions.mjs"],cwd=root,
                                      input=json.dumps(browser_input,allow_nan=False),text=True,capture_output=True,timeout=90)
                if call.returncode:
                    # Browser asserts use fixed strings. Keep errors outside the artifact.
                    raise RuntimeError("Real-fund browser interaction audit failed: "+"·".join(call.stderr.splitlines()[-10:]))
                result["browser"] = json.loads(call.stdout)
            return result
        finally:
            server.shutdown()
            server.server_close()
            worker.join()
            funds.catalog_for_day.cache_clear()
