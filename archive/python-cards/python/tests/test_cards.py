"""Trusted fixture tests only. Production card source must use the Rust sandbox."""
import io
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from promptcut_cards.worker import Worker
from promptcut_cards import Source, TimeRange

SHADER = "uniform sampler2D u_input0; void main(){outColor=texture(u_input0,v_uv);}"


class Cards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.worker = Worker(io.StringIO(), io.StringIO())
        self.number = 0

    def tearDown(self): self.temp.cleanup()

    def call(self, source, time=0, op="evaluate", **payload):
        self.number += 1
        definition = dict(id="test", language="python", entry="Card", source=source, **payload.pop("definition", {}))
        graph = payload.pop("graph", {"nodes": [
            {"id": "card", "adapter": "python", "definitionId": "test", "params": {"gain": 2},
             "inputs": {"A": {"nodeId": "media", "rate": 2, "offset": .25}}},
            {"id": "media", "adapter": "media"}]})
        return self.worker.dispatch(dict(id=str(self.number), scope="fixture", revision="revision", op=op,
            payload=dict(definitions=[definition], graph=graph, nodeId="card", time=time,
                         outputDir=self.temp.name, **payload)))

    def test_lazy_shader_and_symbolic_mapping(self):
        source = f"""class Card:
    need_prerendering = False
    def __init__(self, style=None): self.shader=GLSL({SHADER!r})
    def card(self, source, time): return self.shader(source['A'].time(time + 1), time=2*time+3)
"""
        value = self.call(source, 1.5)
        self.assertEqual(value["inputs"][0]["time"], 5.25)
        self.assertEqual(value["uniforms"]["u_time"], 6)
        registered = self.call(source, op="register")
        self.assertTrue(registered["registered"])
        self.assertEqual(registered["value"]["inputs"][0]["time"]["op"], "add")
        self.assertEqual(self.worker.writer.getvalue(), "")  # GPU path never requests pixels

    def test_python_branch_fallback_and_pixels(self):
        source = """import numpy as np
class Card:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time):
        return np.full((2,3,4), 20 if time > .5 else 10, dtype=np.uint8)
"""
        self.assertFalse(self.call(source, op="register")["registered"])
        value = self.call(source, .75)
        self.assertEqual((value["width"], value["height"], value["bytes"]), (3, 2, 24))
        self.assertEqual(set((Path(self.temp.name) / value["file"]).read_bytes()), {20})

    def test_replay_backwards_repeat_and_source_revision(self):
        source = """class Card:
    need_prerendering = True
    def __init__(self, style=None): self.n=0
    def card(self, source, time):
        self.n += 1
        return {"type":"draw", "commands":[], "count":self.n}
"""
        self.assertEqual(self.call(source, .3, fps=10)["count"], 4)
        self.assertEqual(self.call(source, .3, fps=10)["count"], 4)
        self.assertEqual(self.call(source, .1, fps=10)["count"], 2)
        changed = source.replace("self.n=0", "self.n=10")
        self.assertEqual(self.call(changed, .1, fps=10)["count"], 12)

    def test_params_style_and_no_style_invalidation(self):
        source = """class Card:
    need_prerendering = False
    def __init__(self, style=None): self.style=style
    def card(self, source, time): return {"gain":self.params["gain"], "style":self.style}
"""
        value = self.call(source, definition={"styleKeys": ["accent"]}, style={"accent": "red", "unused": 4})
        self.assertEqual(value, {"gain": 2, "style": {"accent": "red"}})
        count = len(self.worker.instances)
        self.call(source, definition={"styleKeys": ["accent"]}, style={"accent": "red", "unused": 5})
        self.assertEqual(len(self.worker.instances), count)

    def test_audio_interleaved_and_interval(self):
        source = """import numpy as np
class Card:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time):
        return AudioBlock(np.tile([.25,.75], (time.count,1)), time.sample_rate, time.start)
"""
        value = self.call(source, [0.5, 0.501], domain="audio", sampleRate=10000)
        self.assertEqual((value["startSample"], value["frames"], value["channels"]), (5000,10,2))
        array = np.fromfile(Path(self.temp.name)/value["file"], dtype="<f4")
        np.testing.assert_allclose(array[:4], [.25,.75,.25,.75])

    def test_split_audio_keeps_requested_range_while_advancing_card_clock(self):
        source = """import numpy as np
class Card:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time):
        return AudioBlock(np.full((time.count,1), time.start, dtype=np.float32), time.sample_rate, time.start)
"""
        graph = {"nodes": [{"id":"card","adapter":"python","definitionId":"test","timeOffset":2,"inputs":{}}]}
        value = self.call(source, domain="audio", start=100, count=4, sampleRate=100, graph=graph)
        self.assertEqual((value["startSample"], value["frames"]), (100, 4))
        np.testing.assert_allclose(np.fromfile(Path(self.temp.name)/value["file"], dtype="<f4"), [300,300,300,300])

    def test_split_stateful_replays_from_original_local_time(self):
        source = """class Card:
    need_prerendering = True
    def __init__(self, style=None): self.calls=[]
    def card(self, source, time): self.calls.append(time); return {"last":time,"count":len(self.calls)}
"""
        graph = {"nodes": [{"id":"card","adapter":"python","definitionId":"test","timeOffset":2,"inputs":{}}]}
        value = self.call(source, 0.3, fps=10, graph=graph)
        self.assertEqual(value, {"last":2.3,"count":24})

    def test_visual_time_interval(self):
        source = """class Card:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time): return {"t":time}
"""
        value = self.call(source, [0.1, 0.4], fps=10)
        self.assertEqual(len(value["frames"]), 3)
        self.assertAlmostEqual(value["frames"][2]["value"]["t"], .3)

    def test_broker_materializes_and_validates_correlation(self):
        path = Path(self.temp.name)/"input.bin"
        path.write_bytes(bytes([1,2,3,255]))
        source = """class Card:
    need_prerendering = False
    def __init__(self, style=None): pass
    def card(self, source, time): return source['A'].time(time).array().copy()
"""
        response = dict(type="input_result", id="1", revision="revision", queryId="1", ok=True,
            result=dict(type="pixels",format="rgba8",width=1,height=1,stride=4,path=str(path)))
        self.worker.reader = io.StringIO(json.dumps(response)+"\n")
        value = self.call(source, .5)
        self.assertEqual((Path(self.temp.name)/value["file"]).read_bytes(), bytes([1,2,3,255]))
        event = json.loads(self.worker.writer.getvalue())
        self.assertEqual(event["value"]["time"], 1.25)
        self.worker.reader = io.StringIO(json.dumps(response)+"\n")
        with self.assertRaisesRegex(ValueError, "correlation"): self.call(source, 1)

    def test_scope_and_cycles(self):
        with self.assertRaisesRegex(ValueError,"cycle"):
            self.call("class Card:\n def card(self,source,time): pass", graph={"nodes":[{"id":"card","adapter":"media","inputs":{"x":"card"}}]})
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.worker.dispatch({"id":"x","scope":"other","op":"close"})

    def test_source_does_not_mutate_time(self):
        source = Source(lambda name, **query: query["time"])
        self.assertEqual(source.time(.75), .75)
        self.assertEqual(source.time(.25), .25)
        self.assertEqual(tuple(TimeRange(48000, 24000)), (1, 1.5))


if __name__ == "__main__": unittest.main()
