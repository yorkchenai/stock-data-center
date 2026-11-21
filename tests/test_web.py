"""HTTP and saved-result contract tests using the real 1551-row index fixture."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from unittest import TestCase, mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pandas as pd

from stock_analysis.indicators import calculate_indicators
from stock_analysis.web import ROOT, chart_payload, export_demo, load_demo, make_server, main


class WebDataTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frame = calculate_indicators(pd.read_csv(ROOT / 'results/000688_daily.csv'))
        cls.report = {'status': 'success', 'instrument': {'code': '000688', 'market': 'sh', 'kind': 'index'},
                      'provenance': {'source': 'tencent'}, 'start': '2020-07-01', 'end': '2026-11-20'}

    def test_full_history_units_nan_and_values_are_preserved(self):
        payload = chart_payload(self.frame, self.report)
        self.assertEqual(len(payload['rows']), 1551)
        self.assertEqual(payload['rows'][0]['date'], '2020-07-01')
        self.assertEqual(payload['rows'][-1]['date'], '2026-11-20')
        self.assertIsNone(payload['rows'][0]['MA60'])
        self.assertIsNone(payload['rows'][0]['RSI12'])
        self.assertIsNone(payload['rows'][0]['ADX14'])
        self.assertEqual(payload['units'], {'volume_lots': '手', 'VOL5': '手', 'VOL10': '手', 'turnover_cny': '元'})
        for field in ['volume_lots', 'VOL5', 'VOL10', 'DIF', 'DEA', 'MACD_hist', 'RSI12', 'ADX14', '+DI', '-DI']:
            self.assertAlmostEqual(payload['rows'][-1][field], self.frame[field].iloc[-1])
        self.assertEqual(payload['analysis_layers'][-1], 'RSI看相对强弱')
        self.assertNotIn('ADX', ''.join(payload['analysis_layers']))
        json.dumps(payload, allow_nan=False)

    def test_saved_json_and_csv_reuse_without_calculation(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'report.json').write_text(json.dumps(self.report))
            serialized = chart_payload(self.frame, self.report)['rows']
            (directory / 'indicators.json').write_text(json.dumps(serialized))
            self.frame.to_csv(directory / 'indicators.csv', index=False)
            with mock.patch('stock_analysis.web.calculate_indicators', side_effect=AssertionError('must reuse saved values')):
                json_result = load_demo(directory)
                (directory / 'indicators.json').unlink()
                csv_result = load_demo(directory)
            self.assertEqual(json_result['rows'], serialized)
            self.assertEqual(len(csv_result['rows']), 1551)
            self.assertAlmostEqual(csv_result['rows'][-1]['VOL5'], serialized[-1]['VOL5'])

    def test_invalid_or_incomplete_saved_outputs_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Missing precomputed'):
            chart_payload(self.frame.drop(columns='RSI12'), self.report)
        bad = self.frame.copy()
        bad.loc[30, 'DIF'] = float('inf')
        with self.assertRaisesRegex(ValueError, 'Non-finite'):
            chart_payload(bad, self.report)
        with TemporaryDirectory() as temporary:
            (Path(temporary) / 'report.json').write_text(json.dumps(dict(self.report, status='failed')))
            with self.assertRaisesRegex(ValueError, 'status=success'):
                load_demo(temporary)

    def test_static_export_contains_local_library_and_real_data(self):
        with TemporaryDirectory() as temporary:
            directory = export_demo(Path(temporary) / 'demo', chart_payload(self.frame, self.report))
            self.assertTrue((directory / 'index.html').is_file())
            self.assertTrue((directory / 'vendor/lightweight-charts-5.2.0.js').is_file())
            self.assertTrue((directory / 'vendor/LICENSE.lightweight-charts').is_file())
            payload = json.loads((directory / 'api/demo').read_text())
            self.assertFalse(payload['live_analysis'])
            self.assertEqual(len(payload['rows']), 1551)
            self.assertEqual(payload['rows'][-1]['volume_lots'], self.frame.volume_lots.iloc[-1])
            with self.assertRaises(FileExistsError):
                export_demo(directory, payload)


class WebHTTPTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = TemporaryDirectory()
        cls.server = make_server(port=0, output_root=Path(cls.temporary.name))
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temporary.cleanup()

    def test_service_and_cli_default_to_loopback(self):
        self.assertEqual(self.server.server_address[0], '127.0.0.1')
        with mock.patch('stock_analysis.web.make_server') as factory, mock.patch('builtins.print'):
            factory.return_value.serve_forever.side_effect = KeyboardInterrupt
            main(['--port', '0'])
        self.assertEqual(factory.call_args.args[:2], ('127.0.0.1', 0))
        factory.return_value.server_close.assert_called_once()

    def test_home_and_offline_demo_api(self):
        with urlopen(self.base) as response:
            page = response.read().decode()
        self.assertRegex(page, r'成交量及\s+VOL\s+均线单位为手')
        self.assertIn('./vendor/lightweight-charts-5.2.0.js', page)
        with mock.patch('stock_analysis.web.run_analysis', side_effect=AssertionError('demo must be offline')):
            with urlopen(self.base + '/api/demo') as response:
                payload = json.load(response)
        self.assertEqual(len(payload['rows']), 1551)
        self.assertTrue(payload['live_analysis'])

    def test_analyze_delegates_to_existing_pipeline(self):
        frame = calculate_indicators(pd.read_csv(ROOT / 'results/000688_daily.csv'))
        report = {'instrument': {'code': '000688', 'market': 'sh', 'kind': 'index'}, 'provenance': {'source': 'tencent'}}
        data = {'symbol': '000688', 'kind': 'index', 'start': '2020-07-01', 'end': '2026-11-20'}
        request = Request(self.base + '/api/analyze', data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
        with mock.patch('stock_analysis.web.run_analysis', return_value=(frame, report)) as pipeline:
            with urlopen(request) as response:
                payload = json.load(response)
        self.assertEqual(pipeline.call_args.args[0].symbol, 'sh000688')
        self.assertEqual(pipeline.call_args.args[1:], ('2020-07-01', '2026-11-20'))
        self.assertEqual(payload['rows'][-1]['volume_lots'], frame.volume_lots.iloc[-1])

    def test_invalid_queries_do_not_fetch_or_create_outputs(self):
        cases = [
            {'symbol': '000001', 'kind': 'auto', 'start': '2025-01-01', 'end': '2026-11-20'},
            {'symbol': '600519', 'kind': 'stock', 'start': '2026-01-01', 'end': '2025-01-01'},
            {'symbol': '../../x', 'kind': 'auto', 'start': '2025-01-01', 'end': '2026-11-20'},
            {'symbol': '600519', 'kind': 'stock', 'start': 'invalid', 'end': '2026-11-20'},
            {'symbol': '600519'}, [],
        ]
        with mock.patch('stock_analysis.web.run_analysis') as pipeline:
            for data in cases:
                with self.subTest(data=data):
                    request = Request(self.base + '/api/analyze', data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
                    with self.assertRaises(HTTPError) as error:
                        urlopen(request)
                    self.assertEqual(error.exception.code, 400)
            pipeline.assert_not_called()
        self.assertEqual(list(Path(self.temporary.name).iterdir()), [])

    def test_provider_failure_has_no_success_payload(self):
        data = {'symbol': '600519', 'kind': 'stock', 'start': '2025-01-01', 'end': '2026-11-20'}
        request = Request(self.base + '/api/analyze', data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
        with mock.patch('stock_analysis.web.run_analysis', side_effect=RuntimeError('all data sources failed')):
            with self.assertRaises(HTTPError) as error:
                urlopen(request)
        self.assertEqual(error.exception.code, 502)
        self.assertIn('all data sources failed', json.load(error.exception)['error'])
