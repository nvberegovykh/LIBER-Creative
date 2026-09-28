import pathlib, tempfile, unittest
from test_opening_partition import c, fixture, shape

class ClearanceTest(unittest.TestCase):
    def model(self, touch=True, tiny=False):
        objects=fixture(); parent=objects[0];child=next(o for o in objects if o.obj_type=='OS:SubSurface')
        objects=[parent,child]
        c._set_vertices(child,shape(.5,1.5,y0=0 if touch else .5,y1=.01 if tiny else 2))
        return c.ModelData(pathlib.Path('fixture.osm'),objects),parent,child

    def test_clearance_is_bounded_and_parent_unchanged(self):
        model,parent,child=self.model(); before=list(parent.fields);handle=child.handle
        audit=c.normalize_analytical_boundary_clearance(model)
        self.assertEqual(parent.fields,before);self.assertEqual(child.handle,handle)
        self.assertEqual(audit['changedOpenings'],1);self.assertTrue(audit['reviewRequired']);self.assertFalse(audit['lossless'])
        self.assertLess(audit['changes'][0]['areaReductionFraction'],.01)
        self.assertGreater(min(p[1] for p in c.vertices(child)),0)

    def test_already_contained_opening_not_changed(self):
        model,parent,child=self.model(False);before=list(child.fields)
        self.assertEqual(c.normalize_analytical_boundary_clearance(model)['changedOpenings'],0)
        self.assertEqual(child.fields,before)

    def test_excessive_relative_change_stays_blocked(self):
        model,parent,child=self.model(tiny=True);before=list(child.fields)
        self.assertEqual(c.normalize_analytical_boundary_clearance(model)['changedOpenings'],0)
        self.assertEqual(child.fields,before)

    def volumes(self,value='30',second='20'):
        with tempfile.TemporaryDirectory() as td:
            p=pathlib.Path(td)/'test.idf'
            p.write_text(f'Zone,Z,0,0,0,0,1,1,,{value};\nSpace,A,Z,,10;\nSpace,B,Z,,{second};')
            return c.explicit_aggregate_zone_volumes(p)

    def test_review_requires_positive_reconciled_space_volumes(self):
        self.assertTrue(self.volumes()['eligible'])
        self.assertFalse(self.volumes('Autocalculate')['eligible'])
        self.assertFalse(self.volumes('31')['eligible'])
        self.assertFalse(self.volumes(second='0')['eligible'])

    def test_review_never_suppresses_other_native_failures(self):
        warning='** Warning ** CalculateZoneVolume: 2 zones are not fully enclosed.'
        self.assertTrue(c._critical_native_lines(warning))
        self.assertEqual(c._critical_native_lines(warning,True),[])
        for other in ['** Severe ** CalculateZoneVolume: not fully enclosed',
                      '** Fatal ** stopped', '** Warning ** Base surface does not surround subsurface']:
            self.assertTrue(c._critical_native_lines(warning+'\n'+other,True))

if __name__=='__main__':unittest.main()
