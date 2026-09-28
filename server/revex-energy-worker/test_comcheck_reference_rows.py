"""Reference constructions must not become fictitious physical envelope rows."""
import copy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src/Liber.Revex.Revit/Engineering/Energy'))
import revex_energy_pipeline as pipeline


class ReferenceRows(unittest.TestCase):
    def reference(self):
        return {'kind': 'floor', 'assemblyType': 'FS1', 'description': 'FS1 floor',
                'continuousR': 25, 'confidence': .99, 'referenceEnvelopeAuthority': 'APPROVED_REFERENCE'}

    def canonical(self, rows):
        return pipeline.canonicalize_comcheck_envelope_rows([{'sheetNumber': 'EN-001', 'envelope': rows}])

    def test_reference_properties_are_not_geometry(self):
        rows, audit = self.canonical([self.reference()])
        self.assertEqual(rows, [])
        self.assertEqual(audit['referencePropertyOnlyRowsExcluded'], 1)

    def test_current_missing_area_is_not_hidden(self):
        current = self.reference(); del current['referenceEnvelopeAuthority']
        rows, audit = self.canonical([current])
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0].get('grossAreaFt2'))
        self.assertEqual(audit['referencePropertyOnlyRowsExcluded'], 0)

    def test_properties_still_match_current_geometry(self):
        geometry = {'kind': 'floor', 'assemblyType': 'FS1', 'description': 'FS1 floor',
                    'grossAreaFt2': 321, 'confidence': .99}
        source = [self.reference(), geometry]; snapshot = copy.deepcopy(source)
        rows, audit = self.canonical(source)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['grossAreaFt2'], 321)
        self.assertEqual(rows[0]['continuousR'], 25)
        self.assertEqual(audit['thermalPropertyMergeErrorCount'], 0)
        self.assertEqual(source, snapshot)

    def test_unmatched_reference_does_not_add_a_floor(self):
        wall = {'kind': 'wall', 'assemblyType': 'W1', 'description': 'W1 wall',
                'orientation': 'NORTH', 'grossAreaFt2': 123, 'confidence': .99}
        thermal = dict(wall, continuousR=20); thermal.pop('grossAreaFt2')
        rows, audit = self.canonical([wall, thermal, self.reference()])
        self.assertEqual([row['kind'] for row in rows], ['wall'])
        self.assertEqual(audit['referencePropertyOnlyRowsExcluded'], 1)


if __name__ == '__main__':
    unittest.main()
