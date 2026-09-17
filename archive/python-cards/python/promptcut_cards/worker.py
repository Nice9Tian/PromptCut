"""Persistent JSONL worker, started only inside an LPAC job in production."""
import contextlib
import hashlib
import json
import math
from pathlib import Path
import sys
import types
import uuid
from . import sdk

MAX_MESSAGE = 8 * 1024 * 1024
MAX_BUFFER = 256 * 1024 * 1024


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()).hexdigest()


class Worker:
    def __init__(self, reader=None, writer=None):
        self.reader = reader or sys.stdin
        self.writer = writer or sys.stdout
        self.definitions = {}
        self.instances = {}
        self.scope = None
        self.query_counter = 0
        self.request = None
        self.active = set()

    def send(self, value):
        line = json.dumps(value, allow_nan=False, separators=(",", ":"))
        if len(line.encode()) > MAX_MESSAGE: raise ValueError("Control message exceeds budget")
        self.writer.write(line + "\n")
        self.writer.flush()

    def read(self):
        line = self.reader.readline(MAX_MESSAGE + 1)
        if not line: raise EOFError("Broker disconnected")
        if len(line) > MAX_MESSAGE or not line.endswith("\n"): raise ValueError("Invalid or oversized control message")
        return json.loads(line)

    def broker(self, **query):
        self.query_counter += 1
        event = dict(type="input", id=self.request["id"], revision=self.request.get("revision"),
                     queryId=str(self.query_counter), **query)
        self.send(event)
        response = self.read()
        for key in ("id", "revision", "queryId"):
            if response.get(key) != event.get(key): raise ValueError("Input response correlation mismatch")
        if response.get("type") != "input_result" or not response.get("ok"):
            raise RuntimeError(str(response.get("error", "Input unavailable")))
        return response["result"]

    def load(self, definition):
        source = definition.get("source", "")
        entry = definition.get("entry")
        key = digest(definition)
        prior = self.definitions.get(definition["id"])
        if prior and prior["key"] == key: return prior
        if not source or len(source.encode()) > 1024 * 1024: raise ValueError("Invalid Python source size")
        if not isinstance(entry, str) or not entry.isidentifier(): raise ValueError("Invalid Python entry class")
        module = types.ModuleType("promptcut_card_" + key)
        module.__dict__.update({name: getattr(sdk, name) for name in ("GLSL", "Source", "Time", "TimeRange", "AudioBlock", "Frame", "sin", "cos")})
        exec(compile(source, "<card:" + definition["id"] + ">", "exec"), module.__dict__)
        cls = getattr(module, entry)
        if not isinstance(cls, type) or not callable(getattr(cls, "card", None)):
            raise ValueError("Entry must be a card class")
        need = bool(definition.get("need_prerendering", getattr(cls, "need_prerendering", True)))
        need = need or bool(getattr(cls, "need_prerendering", False))
        loaded = dict(key=key, definition=definition, cls=cls, need=need)
        self.definitions[definition["id"]] = loaded
        return loaded

    def selected_style(self, definition, style):
        keys = definition.get("styleKeys")
        return dict(style) if keys is None else {key: style[key] for key in keys if key in style}

    def new_instance(self, loaded, params, style):
        obj = loaded["cls"](style=dict(style))
        obj.params = {**loaded["definition"].get("defaults", {}), **params}
        return dict(obj=obj, last=None, result=None, end=0)

    def prepare_graph(self, payload):
        for definition in payload.get("definitions", []): self.load(definition)
        nodes = payload.get("graph", {}).get("nodes", [])
        if len(nodes) > 10000: raise ValueError("Node budget exceeded")
        self.nodes = {node["id"]: node for node in nodes}
        if len(nodes) != len(self.nodes): raise ValueError("Duplicate node ID")
        self.node_keys = {}
        visiting = set()
        def visit(node_id):
            if node_id in self.node_keys: return self.node_keys[node_id]
            if node_id in visiting: raise ValueError("Card graph cycle")
            if node_id not in self.nodes: raise ValueError("Missing input node: " + node_id)
            visiting.add(node_id)
            node = self.nodes[node_id]
            inputs = {}
            for name, ref in node.get("inputs", {}).items():
                if isinstance(ref, str): ref = {"nodeId": ref}
                rate, offset = ref.get("rate", 1), ref.get("offset", 0)
                if not math.isfinite(rate) or not math.isfinite(offset): raise ValueError("Invalid input timing")
                inputs[name] = [visit(ref["nodeId"]), rate, offset]
            loaded = self.definitions.get(node.get("definitionId"))
            if node.get("adapter") == "python" and loaded is None: raise ValueError("Missing Python definition")
            self.node_keys[node_id] = digest([node, inputs, loaded["key"] if loaded else None,
                self.selected_style(loaded["definition"], payload.get("style", {})) if loaded else None,
                payload.get("inputVersions", {}).get(node_id)])
            visiting.remove(node_id)
            return self.node_keys[node_id]
        for node_id in self.nodes: visit(node_id)

    def evaluate(self, node_id, time=None, block=None, symbolic=False):
        if node_id in self.active: raise ValueError("Recursive card graph")
        node = self.nodes[node_id]
        time_offset = node.get("timeOffset", 0)
        if not isinstance(time_offset, (int, float)) or not math.isfinite(time_offset):
            raise ValueError("Invalid node time offset")
        if node.get("adapter") != "python":
            if block is not None:
                result = self.broker(nodeId=node_id, start=block.start, count=block.count, sampleRate=block.sample_rate)
                import numpy as np
                if result.get("format") != "f32le": raise ValueError("Expected interleaved float32 audio")
                samples = np.fromfile(result["path"], dtype="<f4")
                if samples.size != result["frames"] * result["channels"]: raise ValueError("Audio buffer size mismatch")
                return sdk.AudioBlock(samples.reshape(result["frames"], result["channels"]), result["sampleRate"], result["startSample"])
            value = {"type": "source", "nodeId": node_id, "time": sdk.expression(time)}
            return sdk.Frame(value, None if symbolic else lambda value: self.broker(value=value))
        # Instance state and card arguments use the clip's original local
        # clock after a split.  The response descriptor still uses the
        # caller's requested audio range (serialize receives that separately).
        if block is not None and time_offset:
            block = sdk.TimeRange(block.start + round(time_offset * block.sample_rate), block.count, block.sample_rate)
        elif block is None and time_offset:
            time = time + time_offset
        self.active.add(node_id)
        try:
            loaded = self.definitions[node["definitionId"]]
            if symbolic and loaded["need"]: raise sdk.TraceUnsupported("History-dependent cards cannot register a direct GPU graph")
            payload = self.request.get("payload", {})
            style = self.selected_style(loaded["definition"], payload.get("style", {}))
            params = node.get("params", {})
            domain = "audio" if block is not None else "visual"
            fps = float(payload.get("fps", 30))
            phase = float(payload.get("phase", 0))
            key = digest([node_id, self.node_keys[node_id], domain, fps, phase, block.sample_rate if block else None])
            state = self.new_instance(loaded, params, style) if symbolic else self.instances.get(key)
            if state is None:
                state = self.instances[key] = self.new_instance(loaded, params, style)
            def run(t=None, b=None): return self.run_card(state["obj"], node, t, b, symbolic)
            if symbolic: return run(time)
            if block is not None:
                if block.start < 0 or block.count <= 0 or block.count > 1048576: raise ValueError("Invalid audio range")
                position = (block.start, block.count)
                if loaded["need"]:
                    if state["last"] == position: return state["result"]
                    if block.start < state["end"]:
                        state = self.instances[key] = self.new_instance(loaded, params, style)
                    chunk = int(payload.get("blockSize", 1024))
                    if chunk <= 0 or chunk > 1048576: raise ValueError("Invalid replay block size")
                    while state["end"] < block.start:
                        count = min(chunk, block.start - state["end"])
                        run(b=sdk.TimeRange(state["end"], count, block.sample_rate))
                        state["end"] += count
                result = run(b=block)
                state.update(last=position, result=result, end=block.start + block.count)
                return result
            if not isinstance(time, (int, float)) or not math.isfinite(time): raise ValueError("Invalid card time")
            if fps <= 0 or fps > 240 or not math.isfinite(phase): raise ValueError("Invalid sample grid")
            if loaded["need"]:
                if state["last"] == time: return state["result"]
                if state["last"] is not None and time < state["last"]:
                    state = self.instances[key] = self.new_instance(loaded, params, style)
                first = 0 if state["last"] is None else math.floor((state["last"] - phase) * fps + 1e-8) + 1
                last = math.ceil((time - phase) * fps - 1e-8)
                if last - first > 1000000: raise ValueError("Replay frame budget exceeded")
                for tick in range(first, last): run(phase + tick / fps)
            result = run(time)
            state.update(last=time, result=result)
            return result
        finally:
            self.active.remove(node_id)

    def run_card(self, obj, node, time, block, symbolic):
        inputs = node.get("inputs", {})
        default = next(iter(inputs)) if len(inputs) == 1 else "source"
        def fetch(name, time=None, start=None, count=None):
            name = name or default
            if name not in inputs: raise ValueError("Missing named input: " + name)
            ref = inputs[name]
            if isinstance(ref, str): ref = {"nodeId": ref}
            rate, offset = ref.get("rate", 1), ref.get("offset", 0)
            if start is not None:
                if symbolic: raise sdk.TraceUnsupported("Audio requires Python block evaluation")
                if rate != 1: raise ValueError("Audio rate changes require an explicit resampling card")
                sample_rate = block.sample_rate if block else int(self.request["payload"].get("sampleRate", 48000))
                return self.evaluate(ref["nodeId"], block=sdk.TimeRange(start + round(offset * sample_rate), count, sample_rate))
            if isinstance(time, (tuple, list)):
                return [fetch(name, time=t) for t in self.sample_times(time)]
            result = self.evaluate(ref["nodeId"], time=time * rate + offset, symbolic=symbolic)
            if isinstance(result, sdk.Frame) and result._materialize is None and not symbolic:
                result._materialize = lambda value: self.broker(value=self.serialize(value))
            return result
        return obj.card(sdk.Source(fetch), block if block is not None else time)

    def sample_times(self, interval):
        if len(interval) != 2: raise ValueError("Time range requires two seconds endpoints")
        start, end = map(float, interval)
        fps = float(self.request["payload"].get("fps", 30))
        if not all(map(math.isfinite, (start, end, fps))) or end < start or fps <= 0 or fps > 240:
            raise ValueError("Invalid time range")
        count = math.ceil((end - start) * fps - 1e-9)
        if count > 10000: raise ValueError("Range frame budget exceeded")
        return [start + frame / fps for frame in range(count)]

    def serialize(self, value, block=None):
        import numpy as np
        from PIL import Image
        if isinstance(value, sdk.Frame): return self.serialize(value.value, block)
        if isinstance(value, sdk.Time): return value.expr
        if isinstance(value, Image.Image): value = np.asarray(value.convert("RGBA"))
        if isinstance(value, sdk.AudioBlock):
            block = sdk.TimeRange(value.start_sample, len(value.samples), value.sample_rate)
            value = np.asarray(value.samples, dtype="<f4")
        if isinstance(value, np.ndarray):
            if block is not None:
                if value.ndim == 1: value = value[:, None]
                if value.ndim != 2 or value.shape[1] not in range(1, 33): raise ValueError("Audio shape must be frames,channels")
                value = np.asarray(value, dtype="<f4", order="C")
                if not np.isfinite(value).all(): raise ValueError("Non-finite audio output")
                descriptor = dict(type="audio", format="f32le", sampleRate=block.sample_rate, startSample=block.start,
                                  frames=value.shape[0], channels=value.shape[1])
            else:
                if value.dtype != np.uint8 or value.ndim != 3 or value.shape[2] != 4:
                    raise ValueError("Pixel arrays must be uint8 height,width,4 RGBA")
                value = np.ascontiguousarray(value)
                descriptor = dict(type="pixels", format="rgba8", alpha="straight", width=value.shape[1], height=value.shape[0], stride=value.shape[1] * 4)
            if value.nbytes > MAX_BUFFER: raise ValueError("Output buffer budget exceeded")
            root = Path(self.request["payload"]["outputDir"])
            filename = uuid.uuid4().hex + ".bin"
            with (root / filename).open("xb") as stream: stream.write(value.tobytes())
            return dict(descriptor, file=filename, bytes=value.nbytes)
        if isinstance(value, dict): return {key: self.serialize(item, block) for key, item in value.items()}
        if isinstance(value, (tuple, list)): return [self.serialize(item, block) for item in value]
        if value is None or isinstance(value, (bool, str, int)): return value
        if isinstance(value, (float, np.floating)) and math.isfinite(value): return float(value)
        raise TypeError("Unsupported card result: " + type(value).__name__)

    def dispatch(self, request):
        self.request = request
        scope = request.get("scope")
        if self.scope is None: self.scope = scope
        if scope != self.scope: raise ValueError("Worker authorization scope is immutable")
        payload = request.get("payload", {})
        op = request.get("op")
        if op == "inspect":
            definition = payload.get("definition", payload)
            loaded = self.load(definition)
            self.new_instance(loaded, {}, self.selected_style(definition, payload.get("style", {})))
            return dict(need_prerendering=loaded["need"], compositing=definition.get("compositing", "unknown"))
        if op in ("evaluate", "register"):
            self.prepare_graph(payload)
            symbolic = op == "register" or payload.get("symbolic", False)
            block = None
            interval = payload.get("time", 0)
            if payload.get("domain") == "audio":
                sample_rate = int(payload.get("sampleRate", 48000))
                if isinstance(interval, (list, tuple)):
                    start, end = [round(float(t) * sample_rate) for t in interval]
                    block = sdk.TimeRange(start, end - start, sample_rate)
                else: block = sdk.TimeRange(int(payload["start"]), int(payload["count"]), sample_rate)
            try:
                if isinstance(interval, (list, tuple)) and block is None:
                    values = [{"time": t, "value": self.serialize(self.evaluate(payload["nodeId"], t))} for t in self.sample_times(interval)]
                    return {"type": "frames", "interval": interval, "frames": values}
                result = self.evaluate(payload["nodeId"], sdk.Time() if symbolic else interval, block, symbolic)
                # A split node advances its internal state clock, but the host
                # requested this output range.  Only the root AudioBlock is
                # relabelled; nested/upstream transforms retain their own
                # timing while evaluation is in progress.
                if block is not None and isinstance(result, sdk.AudioBlock):
                    expected_start = block.start + round(self.nodes[payload['nodeId']].get('timeOffset', 0) * block.sample_rate)
                    if result.start_sample != expected_start:
                        raise ValueError('Audio card returned a different internal sample range')
                    result = sdk.AudioBlock(result.samples, result.sample_rate, block.start)
                value = self.serialize(result, block)
                return {"registered": True, "value": value} if op == "register" else value
            except (sdk.TraceUnsupported, TypeError) as error:
                if op == "register": return {"registered": False, "reason": str(error)}
                raise
        if op == "close": return {}
        raise ValueError("Unsupported worker operation: " + str(op))

    def run(self):
        while True:
            try: request = self.read()
            except EOFError: break
            reply = dict(id=request.get("id"), revision=request.get("revision"))
            try:
                with contextlib.redirect_stdout(sys.stderr): result = self.dispatch(request)
                self.send(dict(reply, ok=True, result=result))
            except Exception as error:
                self.send(dict(reply, ok=False, error={"code": "CARD_EXECUTION", "message": str(error)}))
            if request.get("op") == "close": break
