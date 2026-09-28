"""Behavioral checks for supported analytical opening partition, without customer data."""
import hashlib, importlib.util, os, pathlib, sys, tempfile, unittest, uuid
from revex_opening_partition import normalize
from shapely.geometry import Polygon
from shapely.ops import unary_union
CORE = pathlib.Path(os.environ.get('REVEX_GEOMETRY_CORE') or pathlib.Path(__file__).resolve().parents[2] / 'src/Liber.Revex.Revit/Engineering/Energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py')
spec=importlib.util.spec_from_file_location('test_geometry_core', CORE);c=importlib.util.module_from_spec(spec);sys.modules[spec.name]=c;spec.loader.exec_module(c)
def uid(): return '{'+str(uuid.uuid4())+'}'
def shape(x0,x1,y0=0,y1=2,z=0): return [(x0,y0,z),(x1,y0,z),(x1,y1,z),(x0,y1,z)]
def fixture(kind='curtain', offplane=False, paired=False, outside=False):
    parent=c.OSMObject('OS:Surface',[uid(),'test wall','Wall','',uid(),'Outdoors','','SunExposed','WindExposed','',''])
    c._set_vertices(parent,shape(0,4,y1=3))
    objects=[parent];children=[]
    for i,(x0,x1) in enumerate([(0.5,2),(1.5,3 if not outside else 5)]):
        type_='FixedWindow' if i==0 else 'Door'
        label='Curtain Panels : Glazed' if i==0 else 'Doors : Curtain Wall Door'
        if kind=='door':type_='Door';label='Doors : same mechanical type'
        if kind=='unknown':label='Unknown opening'
        child=c.OSMObject('OS:SubSurface',[uid(),'child'+str(i),type_,'',parent.handle,'','','','1',''])
        c._set_vertices(child,shape(x0,x1,y0=.5,y1=2.5,z=.02 if offplane else 0))
        objects += [child,c.OSMObject('OS:AdditionalProperties',[uid(),child.handle,'CADObjectId','String','element'+str(i),'displayName','String',label])]
        children.append(child)
    if paired:
        reverse=parent.clone();reverse.handle=uid();reverse.fields[1]='opposite wall';c._set_vertices(reverse,list(reversed(c.vertices(parent))));objects.append(reverse)
        for i,child in enumerate(children):
            mate=child.clone();mate.handle=uid();mate.fields[1]+=' reversed';mate.fields[4]=reverse.handle;mate.fields[5]=child.handle;child.fields[5]=mate.handle
            c._set_vertices(mate,list(reversed(c.vertices(child))))
            objects += [mate,c.OSMObject('OS:AdditionalProperties',[uid(),mate.handle,'CADObjectId','String','element'+str(i),'displayName','String','Doors : same mechanical type'])]
    return objects
class PartitionTest(unittest.TestCase):
    def run_fixture(self, **kwargs):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);p=pathlib.Path(tmp.name)
        c.write_osm(p/'source.osm',fixture(**kwargs));raw=(p/'source.osm').read_bytes()
        report=normalize(p/'source.osm',p/'derived.osm',p/'review.json',CORE)
        self.assertEqual(raw,(p/'source.osm').read_bytes())
        return c.parse_osm(p/'source.osm'),c.parse_osm(p/'derived.osm'),report
    def test_curtain_cut_preserves_union_ids_and_orientation(self):
        before,after,report=self.run_fixture()
        self.assertEqual(report['changedOpenings'],1);self.assertFalse(report['unresolved'])
        bs=before.by_type['OS:SubSurface'];aps=after.by_type['OS:SubSurface']
        self.assertEqual([o.handle for o in bs],[o.handle for o in aps])
        polygons=lambda rows:[Polygon([(p[0],p[1]) for p in c.vertices(o)]) for o in rows]
        self.assertLess(unary_union(polygons(bs)).symmetric_difference(unary_union(polygons(aps))).area,1e-9)
        self.assertLess(polygons(aps)[0].intersection(polygons(aps)[1]).area,1e-9)
        self.assertTrue(report['repairs'][0]['reviewRequired'])
    def test_identical_door_type_keeps_both_sources(self):
        before,after,r=self.run_fixture(kind='door');self.assertEqual(r['changedOpenings'],1)
        self.assertEqual(len(after.by_type['OS:SubSurface']),2)
    def test_paired_interior_faces_stay_congruent(self):
        before,after,r=self.run_fixture(kind='door',paired=True);self.assertEqual(r['changedOpenings'],2)
        for o in after.by_type['OS:SubSurface']:
            mate=after.by_handle[o.fields[5]]
            self.assertEqual(sorted(c.vertices(o)),sorted(c.vertices(mate)))
    def test_unknown_openings_are_not_repaired(self):
        _,_,r=self.run_fixture(kind='unknown');self.assertEqual(r['changedOpenings'],0);self.assertTrue(r['unresolved'])
    def test_off_plane_opening_is_not_projected_into_wall(self):
        before,after,r=self.run_fixture(offplane=True);self.assertEqual(r['changedOpenings'],0);self.assertTrue(r['unresolved'])
        self.assertEqual(c.vertices(before.by_type['OS:SubSurface'][0]),c.vertices(after.by_type['OS:SubSurface'][0]))
    def test_opening_outside_wall_is_not_clipped(self):
        _,_,r=self.run_fixture(outside=True);self.assertEqual(r['changedOpenings'],0);self.assertTrue(r['unresolved'])
if __name__=='__main__':unittest.main()
