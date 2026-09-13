"""Public card values. Security is enforced by the OS worker, never by this SDK."""
from dataclasses import dataclass
import math


class TraceUnsupported(Exception):
    """The card must run as Python instead of registering a GPU graph."""


class Time:
    """Symbolic time for GPU registration only; normal calls receive float."""
    def __init__(self, expr=None):
        self.expr = expr or {"type": "expr", "op": "time"}

    def _binary(self, op, other, reverse=False):
        args = [self.expr, expression(other)]
        return Time({"type": "expr", "op": op, "args": args[::-1] if reverse else args})

    def __add__(self, other): return self._binary("add", other)
    def __radd__(self, other): return self._binary("add", other, True)
    def __sub__(self, other): return self._binary("sub", other)
    def __rsub__(self, other): return self._binary("sub", other, True)
    def __mul__(self, other): return self._binary("mul", other)
    def __rmul__(self, other): return self._binary("mul", other, True)
    def __truediv__(self, other): return self._binary("div", other)
    def __rtruediv__(self, other): return self._binary("div", other, True)
    def __neg__(self): return Time({"type": "expr", "op": "neg", "args": [self.expr]})
    def __bool__(self): raise TraceUnsupported("Branching on symbolic time requires Python evaluation")
    def __float__(self): raise TraceUnsupported("Numeric conversion requires Python evaluation")
    def __int__(self): raise TraceUnsupported("Integer conversion requires Python evaluation")
    def __lt__(self, other): raise TraceUnsupported("Comparison requires Python evaluation")
    __le__ = __gt__ = __ge__ = __eq__ = __ne__ = __lt__


def expression(value):
    if isinstance(value, Time): return value.expr
    if isinstance(value, (list, tuple)): return [expression(x) for x in value]
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise TraceUnsupported("Uniforms must be finite numbers or explicit time expressions")
    return value


def sin(value):
    return Time({"type": "expr", "op": "sin", "args": [value.expr]}) if isinstance(value, Time) else math.sin(value)


def cos(value):
    return Time({"type": "expr", "op": "cos", "args": [value.expr]}) if isinstance(value, Time) else math.cos(value)


@dataclass(frozen=True)
class TimeRange:
    """Audio sample range, with exact indices and iterable seconds endpoints."""
    start: int
    count: int
    sample_rate: int = 48000

    @property
    def seconds(self): return self.start / self.sample_rate

    def __iter__(self):
        return iter((self.start / self.sample_rate, (self.start + self.count) / self.sample_rate))


@dataclass(frozen=True)
class Source:
    _fetch: object
    _name: str | None = None

    def time(self, time): return self._fetch(self._name, time=time)
    def block(self, start, count): return self._fetch(self._name, start=int(start), count=int(count))
    def __getitem__(self, name): return Source(self._fetch, str(name))


class Frame:
    """A lazy frame reference; array/image materialize only when requested."""
    def __init__(self, value, materialize=None):
        self.value = value
        self._materialize = materialize

    def array(self):
        import numpy as np
        value = self.value
        if value.get("type") != "pixels":
            if self._materialize is None: raise TraceUnsupported("Pixel materialization is unavailable during GPU registration")
            value = self._materialize(value)
        if value.get("format") != "rgba8" or value.get("stride") != value["width"] * 4:
            raise ValueError("Expected tightly packed straight-alpha RGBA8")
        data = np.fromfile(value["path"], dtype=np.uint8)
        if data.size != value["width"] * value["height"] * 4: raise ValueError("Pixel buffer size mismatch")
        data = data.reshape(value["height"], value["width"], 4)
        data.flags.writeable = False
        return data

    def image(self):
        from PIL import Image
        return Image.fromarray(self.array())

    def __array__(self, dtype=None, copy=None):
        array = self.array()
        return array.astype(dtype, copy=True) if dtype is not None else array.copy() if copy else array


@dataclass(frozen=True)
class AudioBlock:
    samples: object
    sample_rate: int = 48000
    start_sample: int = 0


class GLSL:
    def __init__(self, fragment):
        if not isinstance(fragment, str) or not fragment.strip(): raise ValueError("GLSL source is required")
        self.fragment = fragment

    def __call__(self, *inputs, **uniforms):
        return Frame({"type": "glsl", "fragment": self.fragment,
                      "inputs": [x.value if isinstance(x, Frame) else x for x in inputs],
                      "uniforms": {"u_time" if k == "time" else k: expression(v) for k, v in uniforms.items()}})
