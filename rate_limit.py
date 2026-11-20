from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque
from typing import Callable, Hashable


class SlidingWindowLimiter:
    """In-memory sliding-window counter.

    Counts events per key and reports how long a key must wait once it reaches
    ``limit`` events inside ``window_seconds``. State is per process, which suits
    the single-instance deployment this application targets. The number of
    tracked keys is capped so hostile traffic cannot grow memory without bound.
    """

    def __init__(
        self,
        limit: int,
        window_seconds: float,
        *,
        max_keys: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = limit
        self.window = window_seconds
        self.max_keys = max_keys
        self._clock = clock
        self._events: OrderedDict[Hashable, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def _prune(self, key: Hashable, now: float) -> deque[float] | None:
        events = self._events.get(key)
        if events is None:
            return None
        while events and now - events[0] >= self.window:
            events.popleft()
        if not events:
            del self._events[key]
            return None
        return events

    def retry_after(self, key: Hashable) -> float:
        """Seconds until ``key`` may act again; 0 when it is not limited."""
        with self._lock:
            now = self._clock()
            events = self._prune(key, now)
            if events is None or len(events) < self.limit:
                return 0.0
            return max(0.0, self.window - (now - events[0]))

    def hit(self, key: Hashable) -> None:
        with self._lock:
            now = self._clock()
            events = self._prune(key, now)
            if events is None:
                events = self._events[key] = deque()
            events.append(now)
            self._events.move_to_end(key)
            while len(self._events) > self.max_keys:
                self._events.popitem(last=False)

    def reset(self, key: Hashable) -> None:
        with self._lock:
            self._events.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
