"""The geometry disclosure must survive the fixed nine-PDF archive contract."""
import io
import json
import pathlib
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'src/Liber.Revex.Revit/Engineering/Energy'))
import revex_energy_pipeline as pipeline
from pypdf import PdfReader
from reportlab.pdfgen import canvas


class ReviewPackageTest(unittest.TestCase):
    def test_preserves_nine_reports_and_embeds_disclosure(self):
        evidence = {'required': True, 'summary': 'Review opening cuts before filing.',
                    'openingPartition': {'repairs': []}, 'models': {},
                    'zoneVolumePolicy': 'Enclosure remains a review finding.'}
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary); archive_path = root / 'reports.zip'
            with zipfile.ZipFile(archive_path, 'w') as archive:
                for label in pipeline.REVIEW_PACKAGE_PDF_LABELS:
                    data = io.BytesIO(); page = canvas.Canvas(data)
                    page.drawString(30, 720, label); page.save()
                    archive.writestr('Project - ' + label + '.pdf', data.getvalue())
            pipeline.attach_geometry_review_package(archive_path, root, evidence)
            with zipfile.ZipFile(archive_path) as archive:
                self.assertEqual(len(archive.namelist()), 9)
                for name in archive.namelist():
                    self.assertTrue(archive.read(name).startswith(b'%PDF-'))
                reader = PdfReader(io.BytesIO(archive.read('Project - Document Index.pdf')))
                self.assertGreaterEqual(len(reader.pages), 2)
                self.assertIn('Review opening cuts', '\n'.join(p.extract_text() for p in reader.pages))
                attachment = reader.attachments['ANALYTICAL_GEOMETRY_REVIEW.json'][0]
                self.assertEqual(json.loads(attachment), evidence)


if __name__ == '__main__':
    unittest.main()
