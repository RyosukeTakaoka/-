import { serveCallable } from '../_shared/http.ts';
import { createRoom } from '../_shared/rooms.ts';
serveCallable(createRoom);
