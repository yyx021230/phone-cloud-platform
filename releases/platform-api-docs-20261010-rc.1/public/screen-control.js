//#region \0rolldown/runtime.js
var e = Object.create, t = Object.defineProperty, n = Object.getOwnPropertyDescriptor, r = Object.getOwnPropertyNames, i = Object.getPrototypeOf, a = Object.prototype.hasOwnProperty, o = (e, t) => () => (t || (e((t = { exports: {} }).exports, t), e = null), t.exports), s = (e, i, o, s) => {
	if (i && typeof i == "object" || typeof i == "function") for (var c = r(i), l = 0, u = c.length, d; l < u; l++) d = c[l], !a.call(e, d) && d !== o && t(e, d, {
		get: ((e) => i[e]).bind(null, d),
		enumerable: !(s = n(i, d)) || s.enumerable
	});
	return e;
}, c = (n, r, a) => (a = n == null ? {} : e(i(n)), s(r || !n || !n.__esModule ? t(a, "default", {
	value: n,
	enumerable: !0
}) : a, n)), l = /* @__PURE__ */ o(((e) => {
	Object.defineProperty(e, "__esModule", { value: !0 }), e.default = function() {
		function e(e) {
			this.data = e, this.index = 0, this.bitLength = e.byteLength * 8;
		}
		return Object.defineProperty(e.prototype, "bitsAvailable", {
			get: function() {
				return this.bitLength - this.index;
			},
			enumerable: !0,
			configurable: !0
		}), e.prototype.skipBits = function(e) {
			if (this.bitsAvailable < e) throw Error("no bytes available");
			this.index += e;
		}, e.prototype.readBits = function(e) {
			return this.getBits(e, this.index);
		}, e.prototype.getBits = function(e, t, n) {
			if (n === void 0 && (n = !0), this.bitsAvailable < e) throw Error("no bytes available");
			var r = t % 8, i = this.data[t / 8 | 0] & 255 >>> r, a = 8 - r;
			if (a >= e) return n && (this.index += e), i >> a - e;
			n && (this.index += a);
			var o = e - a;
			return i << o | this.getBits(o, t + a, n);
		}, e.prototype.skipLZ = function() {
			var e;
			for (e = 0; e < this.bitLength - this.index; ++e) if (this.getBits(1, this.index + e, !1) !== 0) return this.index += e, e;
			return e;
		}, e.prototype.skipUEG = function() {
			this.skipBits(1 + this.skipLZ());
		}, e.prototype.skipEG = function() {
			this.skipBits(1 + this.skipLZ());
		}, e.prototype.readUEG = function() {
			var e = this.skipLZ();
			return this.readBits(e + 1) - 1;
		}, e.prototype.readEG = function() {
			var e = this.readUEG();
			return 1 & e ? 1 + e >>> 1 : -1 * (e >>> 1);
		}, e.prototype.readBoolean = function() {
			return this.readBits(1) === 1;
		}, e.prototype.readUByte = function() {
			return this.readBits(8);
		}, e.prototype.readUShort = function() {
			return this.readBits(16);
		}, e.prototype.readUInt = function() {
			return this.readBits(32);
		}, e;
	}();
})), u = /* @__PURE__ */ o(((e) => {
	Object.defineProperty(e, "__esModule", { value: !0 });
	var t, n;
	function r(e, r) {
		t = e, n = r ?? e;
	}
	e.setLogger = r;
	function i() {
		return t != null;
	}
	e.isEnable = i;
	function a(e) {
		var n = [...arguments].slice(1);
		t && t.apply(void 0, [e].concat(n));
	}
	e.log = a;
	function o(e) {
		var t = [...arguments].slice(1);
		n && n.apply(void 0, [e].concat(t));
	}
	e.error = o;
})), d = /* @__PURE__ */ o(((e) => {
	Object.defineProperty(e, "__esModule", { value: !0 }), e.default = function() {
		function e(e) {
			this.data = e, this.nri = (e[0] & 96) >> 5, this.ntype = e[0] & 31;
		}
		return Object.defineProperty(e, "NDR", {
			get: function() {
				return 1;
			},
			enumerable: !0,
			configurable: !0
		}), Object.defineProperty(e, "IDR", {
			get: function() {
				return 5;
			},
			enumerable: !0,
			configurable: !0
		}), Object.defineProperty(e, "SEI", {
			get: function() {
				return 6;
			},
			enumerable: !0,
			configurable: !0
		}), Object.defineProperty(e, "SPS", {
			get: function() {
				return 7;
			},
			enumerable: !0,
			configurable: !0
		}), Object.defineProperty(e, "PPS", {
			get: function() {
				return 8;
			},
			enumerable: !0,
			configurable: !0
		}), Object.defineProperty(e, "TYPES", {
			get: function() {
				var t;
				return t = {}, t[e.IDR] = "IDR", t[e.SEI] = "SEI", t[e.SPS] = "SPS", t[e.PPS] = "PPS", t[e.NDR] = "NDR", t;
			},
			enumerable: !0,
			configurable: !0
		}), e.type = function(t) {
			return t.ntype in e.TYPES ? e.TYPES[t.ntype] : "UNKNOWN";
		}, e.prototype.type = function() {
			return this.ntype;
		}, e.prototype.isKeyframe = function() {
			return this.ntype === e.IDR;
		}, e.prototype.getSize = function() {
			return 4 + this.data.byteLength;
		}, e.prototype.getData = function() {
			var e = new Uint8Array(this.getSize());
			return new DataView(e.buffer).setUint32(0, this.getSize() - 4), e.set(this.data, 4), e;
		}, e;
	}();
})), f = /* @__PURE__ */ o(((e) => {
	Object.defineProperty(e, "__esModule", { value: !0 });
	var t = l(), n = u(), r = d();
	e.default = function() {
		function e(e) {
			this.remuxer = e, this.track = e.mp4track;
		}
		return e.prototype.parseSEI = function(t) {
			for (var n = e.readSEI(t), r = 0, i = n; r < i.length; r++) switch (i[r].type) {
				case 0:
					this.track.seiBuffering = !0;
					break;
				case 5: return !0;
				default: break;
			}
			return !1;
		}, e.prototype.parseSPS = function(t) {
			var n = e.readSPS(t);
			this.track.width = n.width, this.track.height = n.height, this.track.sps = [t], this.track.codec = "avc1.";
			for (var r = new DataView(t.buffer, t.byteOffset + 1, 4), i = 0; i < 3; ++i) {
				var a = r.getUint8(i).toString(16);
				a.length < 2 && (a = "0" + a), this.track.codec += a;
			}
		}, e.prototype.parsePPS = function(e) {
			this.track.pps = [e];
		}, e.prototype.parseNAL = function(e) {
			if (!e) return !1;
			var t = !1;
			switch (e.type()) {
				case r.default.NDR:
				case r.default.IDR:
					t = !0;
					break;
				case r.default.SEI:
					t = this.parseSEI(e.getData().subarray(4));
					break;
				case r.default.SPS:
					this.parseSPS(e.getData().subarray(4)), n.log(" Found SPS type NALU frame."), !this.remuxer.readyToDecode && this.track.pps.length > 0 && this.track.sps.length > 0 && (this.remuxer.readyToDecode = !0);
					break;
				case r.default.PPS:
					this.parsePPS(e.getData().subarray(4)), n.log(" Found PPS type NALU frame."), !this.remuxer.readyToDecode && this.track.pps.length > 0 && this.track.sps.length > 0 && (this.remuxer.readyToDecode = !0);
					break;
				default:
					n.log(" Found Unknown type NALU frame. type=" + e.type());
					break;
			}
			return t;
		}, e.skipScalingList = function(e, t) {
			for (var n = 8, r = 8, i = 0; i < t; i++) {
				if (r !== 0) {
					var a = e.readEG();
					r = (n + a + 256) % 256;
				}
				n = r === 0 ? n : r;
			}
		}, e.readSPS = function(e) {
			var t = this.parseSPS(e), n = t.pic_width_in_mbs_minus1, r = t.frame_crop_left_offset, i = t.frame_crop_right_offset, a = t.frame_mbs_only_flag, o = t.pic_height_in_map_units_minus1, s = t.frame_crop_top_offset, c = t.frame_crop_bottom_offset, l = t.sar, u = l[0] / l[1];
			return {
				width: Math.ceil(((n + 1) * 16 - r * 2 - i * 2) * u),
				height: (2 - a) * (o + 1) * 16 - (a ? 2 : 4) * (s + c)
			};
		}, e.parseSPS = function(r) {
			var i = new t.default(r), a = 0, o = 0, s = 0, c = 0;
			i.readUByte();
			var l = i.readUByte(), u = i.readUByte(), d = i.readBits(8), f = i.readUEG();
			if (l === 100 || l === 110 || l === 122 || l === 244 || l === 44 || l === 83 || l === 86 || l === 118 || l === 128 || l === 138 || l === 139 || l === 134) {
				var p = i.readUEG();
				if (p === 3 && i.skipBits(1), i.skipUEG(), i.skipUEG(), i.skipBits(1), i.readBoolean()) for (var m = p === 3 ? 12 : 8, h = 0; h < m; ++h) i.readBoolean() && (h < 6 ? e.skipScalingList(i, 16) : e.skipScalingList(i, 64));
			}
			i.skipUEG();
			var g = i.readUEG();
			if (g === 0) i.readUEG();
			else if (g === 1) {
				i.skipBits(1), i.skipEG(), i.skipEG();
				for (var _ = i.readUEG(), h = 0; h < _; ++h) i.skipEG();
			}
			i.skipUEG(), i.skipBits(1);
			var v = i.readUEG(), y = i.readUEG(), b = i.readBits(1);
			b === 0 && i.skipBits(1), i.skipBits(1), i.readBoolean() && (a = i.readUEG(), o = i.readUEG(), s = i.readUEG(), c = i.readUEG());
			var x = i.readBoolean(), S = !1, C = [1, 1];
			if (x) {
				if (S = i.readBoolean(), S) {
					var w = i.readUByte();
					switch (w) {
						case 1:
							C = [1, 1];
							break;
						case 2:
							C = [12, 11];
							break;
						case 3:
							C = [10, 11];
							break;
						case 4:
							C = [16, 11];
							break;
						case 5:
							C = [40, 33];
							break;
						case 6:
							C = [24, 11];
							break;
						case 7:
							C = [20, 11];
							break;
						case 8:
							C = [32, 11];
							break;
						case 9:
							C = [80, 33];
							break;
						case 10:
							C = [18, 11];
							break;
						case 11:
							C = [15, 11];
							break;
						case 12:
							C = [64, 33];
							break;
						case 13:
							C = [160, 99];
							break;
						case 14:
							C = [4, 3];
							break;
						case 15:
							C = [3, 2];
							break;
						case 16:
							C = [2, 1];
							break;
						case 255:
							C = [i.readUByte() << 8 | i.readUByte(), i.readUByte() << 8 | i.readUByte()];
							break;
						default: n.error("  H264: Unknown aspectRatioIdc=" + w);
					}
				}
				if (i.readBoolean() && i.skipBits(1), i.readBoolean() && (i.skipBits(4), i.readBoolean() && i.skipBits(24)), i.readBoolean() && (i.skipUEG(), i.skipUEG()), i.readBoolean()) if (i.bitsAvailable > 64) {
					var T = i.readUInt(), E = i.readUInt(), D = i.readBoolean(), O = E / (2 * T);
					n.log("timescale: " + E + "; unitsInTick: " + T + "; " + ("fixedFramerate: " + D + "; avgFrameDuration: " + O));
				} else n.log("Truncated VUI (" + i.bitsAvailable + ")");
			}
			return {
				profile_idc: l,
				constraint_set_flags: u,
				level_idc: d,
				seq_parameter_set_id: f,
				pic_width_in_mbs_minus1: v,
				pic_height_in_map_units_minus1: y,
				frame_mbs_only_flag: b,
				frame_crop_left_offset: a,
				frame_crop_right_offset: o,
				frame_crop_top_offset: s,
				frame_crop_bottom_offset: c,
				sar: C
			};
		}, e.readSEI = function(e) {
			var n = new t.default(e);
			n.skipBits(8);
			for (var r = []; n.bitsAvailable > 24;) r.push(this.readSEIMessage(n));
			return r;
		}, e.readSEIMessage = function(e) {
			function t() {
				for (var t = 0;;) {
					var n = e.readUByte();
					if (t += n, n !== 255) break;
				}
				return t;
			}
			var n = t(), r = t();
			return this.readSEIPayload(e, n, r);
		}, e.readSEIPayload = function(e, t, n) {
			var r;
			switch (t) {
				default: r = { type: t }, e.skipBits(n * 8);
			}
			return e.skipBits(e.bitsAvailable % 8), r;
		}, e;
	}();
})), p = /* @__PURE__ */ o(((e) => {
	Object.defineProperty(e, "__esModule", { value: !0 });
	var t = f(), n = u(), r = d(), i = 1;
	e.default = function() {
		function e(n, r, i) {
			this.fps = n, this.framePerFragment = r, this.timescale = i, this.readyToDecode = !1, this.totalDTS = 0, this.stepDTS = Math.round(this.timescale / this.fps), this.frameCount = 0, this.seq = 1, this.mp4track = {
				id: e.getTrackID(),
				type: "video",
				len: 0,
				codec: "",
				sps: [],
				pps: [],
				seiBuffering: !1,
				width: 0,
				height: 0,
				timescale: i,
				duration: i,
				samples: [],
				isKeyFrame: !0
			}, this.unitSamples = [[]], this.parser = new t.default(this);
		}
		return e.getTrackID = function() {
			return i++;
		}, Object.defineProperty(e.prototype, "seqNum", {
			get: function() {
				return this.seq;
			},
			enumerable: !0,
			configurable: !0
		}), e.prototype.remux = function(e) {
			if (this.mp4track.seiBuffering && e.type() === r.default.SEI || (this.parser.parseNAL(e) && (this.unitSamples[this.unitSamples.length - 1].push(e), this.mp4track.len += e.getSize(), this.mp4track.isKeyFrame = e.isKeyframe()), !this.mp4track.seiBuffering && (e.type() === r.default.IDR || e.type() === r.default.NDR))) return this.createNextFrame();
		}, e.prototype.createNextFrame = function() {
			if (this.mp4track.len > 0) {
				if (this.frameCount++, this.frameCount % this.framePerFragment === 0) {
					var e = this.getFragment();
					if (e) {
						var t = this.totalDTS;
						return this.totalDTS = this.stepDTS * this.frameCount, [t, e];
					} else n.log("No mp4 sample data.");
				}
				this.unitSamples.push([]);
			}
		}, e.prototype.flush = function() {
			this.seq++, this.mp4track.len = 0, this.mp4track.samples = [], this.mp4track.isKeyFrame = !1, this.unitSamples = [[]];
		}, e.prototype.getFragment = function() {
			if (this.checkReadyToDecode()) {
				var e = new Uint8Array(this.mp4track.len);
				this.mp4track.samples = [];
				for (var t = 0, n = 0, r = this.unitSamples.length; n < r; n++) {
					var i = this.unitSamples[n];
					if (i.length !== 0) {
						for (var a = {
							size: 0,
							cts: this.stepDTS * n
						}, o = 0, s = i; o < s.length; o++) {
							var c = s[o];
							a.size += c.getSize(), e.set(c.getData(), t), t += c.getSize();
						}
						this.mp4track.samples.push(a);
					}
				}
				if (t !== 0) return e;
			}
		}, e.prototype.checkReadyToDecode = function() {
			return !this.readyToDecode || this.unitSamples.filter(function(e) {
				return e.length > 0;
			}).length === 0 ? (n.log("Not ready to decode! readyToDecode(" + this.readyToDecode + ") is false or units is empty."), !1) : !0;
		}, e;
	}();
})), m = /* @__PURE__ */ o(((e) => {
	Object.defineProperty(e, "__esModule", { value: !0 }), e.default = function() {
		function e() {}
		return e.init = function() {
			for (var t in e.initalized = !0, e.types = {
				avc1: [],
				avcC: [],
				btrt: [],
				dinf: [],
				dref: [],
				esds: [],
				ftyp: [],
				hdlr: [],
				mdat: [],
				mdhd: [],
				mdia: [],
				mfhd: [],
				minf: [],
				moof: [],
				moov: [],
				mp4a: [],
				mvex: [],
				mvhd: [],
				sdtp: [],
				stbl: [],
				stco: [],
				stsc: [],
				stsd: [],
				stsz: [],
				stts: [],
				styp: [],
				tfdt: [],
				tfhd: [],
				traf: [],
				trak: [],
				trun: [],
				trep: [],
				trex: [],
				tkhd: [],
				vmhd: [],
				smhd: []
			}, e.types) e.types.hasOwnProperty(t) && (e.types[t] = [
				t.charCodeAt(0),
				t.charCodeAt(1),
				t.charCodeAt(2),
				t.charCodeAt(3)
			]);
			var n = new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				118,
				105,
				100,
				101,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				86,
				105,
				100,
				101,
				111,
				72,
				97,
				110,
				100,
				108,
				101,
				114,
				0
			]), r = new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				12,
				117,
				114,
				108,
				32,
				0,
				0,
				0,
				1
			]);
			e.STTS = e.STSC = e.STCO = new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0
			]), e.STSZ = new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0
			]), e.VMHD = new Uint8Array([
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0
			]), e.SMHD = new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0
			]), e.STSD = new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1
			]), e.FTYP = e.box(e.types.ftyp, new Uint8Array([
				105,
				115,
				111,
				53,
				0,
				0,
				0,
				1,
				97,
				118,
				99,
				49,
				105,
				115,
				111,
				53,
				100,
				97,
				115,
				104
			])), e.STYP = e.box(e.types.styp, new Uint8Array([
				109,
				115,
				100,
				104,
				0,
				0,
				0,
				0,
				109,
				115,
				100,
				104,
				109,
				115,
				105,
				120
			])), e.DINF = e.box(e.types.dinf, e.box(e.types.dref, r)), e.HDLR = e.box(e.types.hdlr, n);
		}, e.box = function(e) {
			for (var t = [...arguments].slice(1), n = 8, r = 0, i = t; r < i.length; r++) {
				var a = i[r];
				n += a.byteLength;
			}
			var o = new Uint8Array(n);
			o[0] = n >> 24 & 255, o[1] = n >> 16 & 255, o[2] = n >> 8 & 255, o[3] = n & 255, o.set(e, 4), n = 8;
			for (var s = 0, c = t; s < c.length; s++) {
				var l = c[s];
				o.set(l, n), n += l.byteLength;
			}
			return o;
		}, e.mdat = function(t) {
			return e.box(e.types.mdat, t);
		}, e.mdhd = function(t) {
			return e.box(e.types.mdhd, new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				2,
				t >> 24 & 255,
				t >> 16 & 255,
				t >> 8 & 255,
				t & 255,
				0,
				0,
				0,
				0,
				85,
				196,
				0,
				0
			]));
		}, e.mdia = function(t) {
			return e.box(e.types.mdia, e.mdhd(t.timescale), e.HDLR, e.minf(t));
		}, e.mfhd = function(t) {
			return e.box(e.types.mfhd, new Uint8Array([
				0,
				0,
				0,
				0,
				t >> 24,
				t >> 16 & 255,
				t >> 8 & 255,
				t & 255
			]));
		}, e.minf = function(t) {
			return e.box(e.types.minf, e.box(e.types.vmhd, e.VMHD), e.DINF, e.stbl(t));
		}, e.moof = function(t, n, r) {
			return e.box(e.types.moof, e.mfhd(t), e.traf(r, n));
		}, e.moov = function(t, n, r) {
			for (var i = [], a = 0, o = t; a < o.length; a++) {
				var s = o[a];
				i.push(e.trak(s));
			}
			return e.box.apply(e, [
				e.types.moov,
				e.mvhd(r, n),
				e.mvex(t)
			].concat(i));
		}, e.mvhd = function(t, n) {
			var r = new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				2,
				t >> 24 & 255,
				t >> 16 & 255,
				t >> 8 & 255,
				t & 255,
				n >> 24 & 255,
				n >> 16 & 255,
				n >> 8 & 255,
				n & 255,
				0,
				1,
				0,
				0,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				64,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				2
			]);
			return e.box(e.types.mvhd, r);
		}, e.mvex = function(t) {
			for (var n = [], r = 0, i = t; r < i.length; r++) {
				var a = i[r];
				n.push(e.trex(a));
			}
			return e.box.apply(e, [e.types.mvex].concat(n, [e.trep()]));
		}, e.trep = function() {
			return e.box(e.types.trep, new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1
			]));
		}, e.stbl = function(t) {
			return e.box(e.types.stbl, e.stsd(t), e.box(e.types.stts, e.STTS), e.box(e.types.stsc, e.STSC), e.box(e.types.stsz, e.STSZ), e.box(e.types.stco, e.STCO));
		}, e.avc1 = function(t) {
			for (var n = [], r = [], i = 0, a = t.sps; i < a.length; i++) {
				var o = a[i], s = o.byteLength;
				n.push(s >>> 8 & 255), n.push(s & 255), n = n.concat(Array.prototype.slice.call(o));
			}
			for (var c = 0, l = t.pps; c < l.length; c++) {
				var o = l[c], s = o.byteLength;
				r.push(s >>> 8 & 255), r.push(s & 255), r = r.concat(Array.prototype.slice.call(o));
			}
			var u = e.box(e.types.avcC, new Uint8Array([
				1,
				n[3],
				n[4],
				n[5],
				255,
				224 | t.sps.length
			].concat(n, [t.pps.length], r))), d = t.width, f = t.height;
			return e.box(e.types.avc1, new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				d >> 8 & 255,
				d & 255,
				f >> 8 & 255,
				f & 255,
				0,
				72,
				0,
				0,
				0,
				72,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1,
				18,
				98,
				105,
				110,
				101,
				108,
				112,
				114,
				111,
				46,
				114,
				117,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				24,
				17,
				17
			]), u, e.box(e.types.btrt, new Uint8Array([
				0,
				0,
				0,
				0,
				0,
				45,
				198,
				192,
				0,
				45,
				198,
				192
			])));
		}, e.stsd = function(t) {
			return e.box(e.types.stsd, e.STSD, e.avc1(t));
		}, e.tkhd = function(t) {
			var n = t.id, r = t.width, i = t.height;
			return e.box(e.types.tkhd, new Uint8Array([
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				2,
				n >> 24 & 255,
				n >> 16 & 255,
				n >> 8 & 255,
				n & 255,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				+(t.type === "audio"),
				0,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				64,
				0,
				0,
				0,
				r >> 8 & 255,
				r & 255,
				0,
				0,
				i >> 8 & 255,
				i & 255,
				0,
				0
			]));
		}, e.traf = function(t, n) {
			var r = t.id;
			return e.box(e.types.traf, e.box(e.types.tfhd, new Uint8Array([
				0,
				2,
				0,
				0,
				r >> 24,
				r >> 16 & 255,
				r >> 8 & 255,
				r & 255
			])), e.box(e.types.tfdt, new Uint8Array([
				0,
				0,
				0,
				0,
				n >> 24,
				n >> 16 & 255,
				n >> 8 & 255,
				n & 255
			])), e.trun(t, 72));
		}, e.trak = function(t) {
			return t.duration = t.duration || 4294967295, e.box(e.types.trak, e.tkhd(t), e.mdia(t));
		}, e.trex = function(t) {
			var n = t.id;
			return e.box(e.types.trex, new Uint8Array([
				0,
				0,
				0,
				0,
				n >> 24,
				n >> 16 & 255,
				n >> 8 & 255,
				n & 255,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				60,
				0,
				0,
				0,
				0,
				0,
				1,
				0,
				0
			]));
		}, e.trun = function(t, n) {
			var r = t.samples || [], i = r.length, a = t.isKeyFrame ? 4 : 0, o = 12 + a + 4 * i, s = new Uint8Array(o);
			n += 8 + o, s.set([
				0,
				0,
				2,
				t.isKeyFrame ? 5 : 1,
				i >>> 24 & 255,
				i >>> 16 & 255,
				i >>> 8 & 255,
				i & 255,
				n >>> 24 & 255,
				n >>> 16 & 255,
				n >>> 8 & 255,
				n & 255
			], 0), t.isKeyFrame && s.set([
				0,
				0,
				0,
				0
			], 12);
			for (var c = 0; c < i; c++) {
				var l = r[c].size;
				s.set([
					l >>> 24 & 255,
					l >>> 16 & 255,
					l >>> 8 & 255,
					l & 255
				], 12 + a + 4 * c);
			}
			return e.box(e.types.trun, s);
		}, e.initSegment = function(t, n, r) {
			e.initalized || e.init();
			var i = e.moov(t, n, r), a = new Uint8Array(e.FTYP.byteLength + i.byteLength);
			return a.set(e.FTYP), a.set(i, e.FTYP.byteLength), a;
		}, e.fragmentSegment = function(t, n, r, i) {
			var a = e.moof(t, n, r), o = e.mdat(i), s = new Uint8Array(e.STYP.byteLength + a.byteLength + o.byteLength);
			return s.set(e.STYP), s.set(a, e.STYP.byteLength), s.set(o, e.STYP.byteLength + a.byteLength), s;
		}, e.types = {}, e.initalized = !1, e;
	}();
})), h = /* @__PURE__ */ o(((e) => {
	Object.defineProperty(e, "__esModule", { value: !0 });
	var t = d();
	e.default = function() {
		function e() {}
		return e.prototype.clear = function() {
			this.buffer = void 0;
		}, e.prototype.append = function(e) {
			var n = function(e) {
				var t = 3;
				return function() {
					for (var n = 0; t < e.length; t++) switch (e[t]) {
						case 0:
							n++;
							break;
						case 1: if (n === 3) return t - 3;
						default: n = 0;
					}
				};
			}, r = [], i;
			this.buffer && e[3] === 1 && e[2] === 0 && e[1] === 0 && e[0] === 0 && (r.push(new t.default(this.buffer.subarray(4))), i = Uint8Array.from(e)), i ??= this.mergeBuffer(e);
			for (var a = 0, o = n(i), s = o(); s != null; s = o()) r.push(new t.default(i.subarray(a + 4, s))), a = s;
			return this.buffer = i.subarray(a), r;
		}, e.prototype.mergeBuffer = function(e) {
			if (this.buffer == null) return Uint8Array.from(e);
			var t = new Uint8Array(this.buffer.byteLength + e.length);
			return this.buffer.byteLength > 0 && t.set(this.buffer, 0), t.set(e, this.buffer.byteLength), t;
		}, e;
	}();
})), g = /* @__PURE__ */ c((/* @__PURE__ */ o(((e) => {
	Object.defineProperty(e, "__esModule", { value: !0 });
	var t = p(), n = m(), r = u(), i = h();
	e.mimeType = "video/mp4; codecs=\"avc1.42E01E\"", e.setLogger = u().setLogger, e.default = function() {
		function a(t, n, r) {
			if (n === void 0 && (n = 60), r === void 0 && (r = n), this.element = t, this.fps = n, this.fpf = r, this.receiveBuffer = new i.default(), this.queue = [], !MediaSource || !MediaSource.isTypeSupported(e.mimeType)) throw Error("Your browser is not supported: " + e.mimeType);
			this.reset();
		}
		return Object.defineProperty(a, "errorNotes", {
			get: function() {
				var e;
				return e = {}, e[MediaError.MEDIA_ERR_ABORTED] = "fetching process aborted by user", e[MediaError.MEDIA_ERR_NETWORK] = "error occurred when downloading", e[MediaError.MEDIA_ERR_DECODE] = "error occurred when decoding", e[MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED] = "audio/video not supported", e;
			},
			enumerable: !0,
			configurable: !0
		}), a.prototype.setup = function() {
			var t = this;
			return this.mediaReadyPromise = new Promise(function(n, i) {
				t.mediaSource.addEventListener("sourceopen", function() {
					r.log("Media Source opened."), t.sourceBuffer = t.mediaSource.addSourceBuffer(e.mimeType), t.sourceBuffer.addEventListener("updateend", function() {
						r.log("  SourceBuffer updateend"), r.log("    sourceBuffer.buffered.length=" + t.sourceBuffer.buffered.length);
						for (var e = 0, n = t.sourceBuffer.buffered.length; e < n; e++) r.log("    sourceBuffer.buffered [" + e + "]: " + (t.sourceBuffer.buffered.start(e) + ", " + t.sourceBuffer.buffered.end(e)));
						if (r.log("  mediasource.duration=" + t.mediaSource.duration), r.log("  mediasource.readyState=" + t.mediaSource.readyState), r.log("  video.duration=" + t.element.duration), r.log("    video.buffered.length=" + t.element.buffered.length), r.isEnable()) for (var e = 0, n = t.element.buffered.length; e < n; e++) r.log("    video.buffered [" + e + "]: " + t.element.buffered.start(e) + ", " + t.element.buffered.end(e));
						if (r.log("  video.currentTime=" + t.element.currentTime), r.log("  video.readyState=" + t.element.readyState), !t.sourceBuffer.updating) {
							var i = t.queue.shift();
							i && t.doAppend(i);
						}
					}), t.sourceBuffer.addEventListener("error", function() {
						r.error("  SourceBuffer errored!");
					}), t.mediaReady = !0, n();
				}, !1), t.mediaSource.addEventListener("sourceclose", function() {
					r.log("Media Source closed."), t.mediaReady = !1;
				}, !1), t.element.src = URL.createObjectURL(t.mediaSource);
			}), this.mediaReadyPromise;
		}, a.prototype.play = function() {
			var e = this;
			if (this.element.paused) if (this.mediaReady && this.element.readyState >= 2) this.element.play();
			else {
				var t = function() {
					e.play(), e.element.removeEventListener("canplaythrough", t);
				};
				this.element.addEventListener("canplaythrough", t);
			}
		}, a.prototype.pause = function() {
			this.element.paused || this.element.pause();
		}, a.prototype.reset = function() {
			if (this.receiveBuffer.clear(), this.mediaSource && this.mediaSource.readyState === "open" && this.sourceBuffer.updating) {
				var e = this.mediaSource;
				this.sourceBuffer.addEventListener("updateend", function() {
					e.endOfStream();
				});
			}
			this.mediaSource = new MediaSource(), this.remuxer = new t.default(this.fps, this.fpf, this.fps * 60), this.mediaReady = !1, this.mediaReadyPromise = void 0, this.queue = [], this.setup();
		}, a.prototype.appendRawData = function(e) {
			for (var t = this.receiveBuffer.append(e), n = 0, r = t; n < r.length; n++) {
				var i = r[n], a = this.remuxer.remux(i);
				a && this.writeFragment(a[0], a[1]);
			}
		}, a.prototype.writeFragment = function(e, t) {
			var i = this.remuxer;
			if (i.mp4track.isKeyFrame && this.writeBuffer(n.default.initSegment([i.mp4track], Infinity, i.timescale)), t && t.byteLength) {
				r.log(" Put fragment: " + i.seqNum + ", frames=" + i.mp4track.samples.length + ", size=" + t.byteLength);
				var a = n.default.fragmentSegment(i.seqNum, e, i.mp4track, t);
				this.writeBuffer(a), i.flush();
			} else r.error("Nothing payload!");
		}, a.prototype.writeBuffer = function(e) {
			var t = this;
			this.mediaReady ? this.sourceBuffer.updating || this.queue.length ? this.queue.push(e) : this.doAppend(e) : (this.queue.push(e), this.mediaReadyPromise &&= (this.mediaReadyPromise.then(function() {
				if (!t.sourceBuffer.updating) {
					var e = t.queue.shift();
					e && t.doAppend(e);
				}
			}), void 0));
		}, a.prototype.doAppend = function(e) {
			var t = this.element.error;
			if (t) r.error("MSE Error Occured: " + a.errorNotes[t.code]), this.element.pause(), this.mediaSource.readyState === "open" && this.mediaSource.endOfStream();
			else try {
				this.sourceBuffer.appendBuffer(e), r.log("  appended buffer: size=" + e.byteLength);
			} catch (e) {
				r.error("MSE Error occured while appending buffer. " + e.name + ": " + e.message);
			}
		}, a;
	}();
})))(), 1), _ = g.default?.default || g.default, v = new Uint8Array([
	0,
	0,
	0,
	1,
	9,
	240
]), y = g.mimeType || "video/mp4; codecs=\"avc1.42E01E\"", b = 30, x = 1, S = class {
	constructor({ video: e, onFirstFrame: t = () => {}, onStats: n = () => {}, onError: r = () => {}, Converter: i = _, mediaSourceApi: a = globalThis.MediaSource, firstFrameTimeoutMs: o = 15e3, setTimer: s = globalThis.setTimeout.bind(globalThis), clearTimer: c = globalThis.clearTimeout.bind(globalThis), setRepeatingTimer: l = globalThis.setInterval.bind(globalThis), clearRepeatingTimer: u = globalThis.clearInterval.bind(globalThis), now: d = () => globalThis.performance?.now?.() || Date.now() }) {
		if (!e) throw Error("缺少实时投屏 video 元素");
		if (!a || typeof a.isTypeSupported != "function" || !a.isTypeSupported(y)) throw Error("当前浏览器不支持实时投屏");
		this.video = e, this.onFirstFrame = t, this.onStats = n, this.onError = r, this.Converter = i, this.firstFrameTimeoutMs = o, this.setTimer = s, this.clearTimer = c, this.setRepeatingTimer = l, this.clearRepeatingTimer = u, this.now = d, this.converter = null, this.firstFrameTimer = null, this.monitorTimer = null, this.frameCallbackId = null, this.started = !1, this.hasFirstFrame = !1, this.failed = !1, this.presentedFrames = 0, this.lastQuality = {
			decoded: 0,
			dropped: 0,
			presented: 0,
			at: this.now()
		}, this.handleLoadedData = () => this.markFirstFrame(), this.handleVideoError = () => this.fail(Error(this.describeVideoError()));
	}
	start() {
		this.started || (this.started = !0, this.failed = !1, this.video.addEventListener("loadeddata", this.handleLoadedData), this.video.addEventListener("error", this.handleVideoError), this.converter = new this.Converter(this.video, b, x), this.converter.play(), this.requestNextVideoFrame(), this.firstFrameTimer = this.setTimer(() => {
			this.fail(/* @__PURE__ */ Error("已连接执行器，但 15 秒内未收到可播放画面"));
		}, this.firstFrameTimeoutMs), this.monitorTimer = this.setRepeatingTimer(() => this.monitorPlayback(), 250));
	}
	write(e) {
		if (!this.started || this.failed || !e?.byteLength) return;
		let t = new Uint8Array(e.byteLength + v.byteLength);
		t.set(e, 0), t.set(v, e.byteLength), this.converter.appendRawData(t);
	}
	stop() {
		this.firstFrameTimer && this.clearTimer(this.firstFrameTimer), this.monitorTimer && this.clearRepeatingTimer(this.monitorTimer), this.frameCallbackId != null && typeof this.video.cancelVideoFrameCallback == "function" && this.video.cancelVideoFrameCallback(this.frameCallbackId), this.firstFrameTimer = null, this.monitorTimer = null, this.frameCallbackId = null, this.video.removeEventListener("loadeddata", this.handleLoadedData), this.video.removeEventListener("error", this.handleVideoError);
		try {
			this.converter?.appendRawData(/* @__PURE__ */ new Uint8Array());
		} catch {}
		try {
			this.converter?.pause();
		} catch {}
		this.converter = null, this.video.pause?.(), "playbackRate" in this.video && (this.video.playbackRate = 1), this.video.removeAttribute?.("src"), this.video.load?.(), this.started = !1, this.hasFirstFrame = !1;
	}
	requestNextVideoFrame() {
		!this.started || typeof this.video.requestVideoFrameCallback != "function" || (this.frameCallbackId = this.video.requestVideoFrameCallback(() => {
			this.started && (this.presentedFrames += 1, this.markFirstFrame(), this.requestNextVideoFrame());
		}));
	}
	markFirstFrame() {
		!this.started || this.hasFirstFrame || this.failed || (this.hasFirstFrame = !0, this.firstFrameTimer && this.clearTimer(this.firstFrameTimer), this.firstFrameTimer = null, this.video.play?.().catch?.((e) => this.fail(e)), this.onFirstFrame({
			decoderBackend: "mse",
			videoWidth: Number(this.video.videoWidth || 0),
			videoHeight: Number(this.video.videoHeight || 0)
		}));
	}
	monitorPlayback() {
		if (!this.started || this.failed) return;
		let e = this.video.buffered, t = 0;
		if (e?.length) {
			let n = e.length - 1, r = e.start(n), i = e.end(n);
			t = Math.max(0, i - Number(this.video.currentTime || 0)), t > .45 ? (this.video.currentTime = Math.max(r, i - .08), t = Math.max(0, i - this.video.currentTime), this.video.playbackRate = 1) : t > .15 ? this.video.playbackRate = 1.12 : t < .08 && (this.video.playbackRate = 1);
		}
		let n = this.video.getVideoPlaybackQuality?.(), r = this.now(), i = n ? Number(n.totalVideoFrames || 0) : this.presentedFrames, a = n ? Number(n.droppedVideoFrames || 0) : 0, o = this.presentedFrames, s = Math.max(.001, (r - this.lastQuality.at) / 1e3), c = Math.max(0, (o - this.lastQuality.presented) / s);
		this.lastQuality = {
			decoded: i,
			dropped: a,
			presented: o,
			at: r
		}, this.onStats({
			decoded: i,
			dropped: a,
			presented: o,
			fps: c,
			bufferSeconds: t
		});
	}
	fail(e) {
		this.failed || (this.failed = !0, this.onError(e instanceof Error ? e : Error(String(e || "视频解码失败"))));
	}
	describeVideoError() {
		let e = Number(this.video.error?.code || 0);
		return e === 3 ? "浏览器无法解码手机视频流" : e === 4 ? "浏览器不支持手机视频格式" : "实时画面播放失败";
	}
}, C = class {
	constructor({ video: e, onFirstFrame: t = () => {}, onVideoFrame: n = () => {}, onStats: r = () => {}, onError: i = () => {}, RTCPeerConnectionCtor: a = globalThis.RTCPeerConnection, fetchFn: o = globalThis.fetch?.bind(globalThis), now: s = () => globalThis.performance?.now?.() || Date.now(), setRepeatingTimer: c = globalThis.setInterval.bind(globalThis), clearRepeatingTimer: l = globalThis.clearInterval.bind(globalThis), setDelayTimer: u = globalThis.setTimeout.bind(globalThis), clearDelayTimer: d = globalThis.clearTimeout.bind(globalThis), sleepFn: f = N } = {}) {
		if (!e) throw Error("缺少实时投屏 video 元素");
		if (!a || !o) throw Error("当前浏览器不支持 WebRTC 实时投屏");
		this.video = e, this.onFirstFrame = t, this.onVideoFrame = n, this.onStats = r, this.onError = i, this.RTCPeerConnectionCtor = a, this.fetch = o, this.now = s, this.setRepeatingTimer = c, this.clearRepeatingTimer = l, this.setDelayTimer = u, this.clearDelayTimer = d, this.sleep = f, this.pc = null, this.resourceUrl = "", this.controller = null, this.token = "", this.monitorTimer = null, this.disconnectTimer = null, this.reconnectTimer = null, this.startOptions = null, this.reconnectAttempts = 0, this.frameCallbackId = null, this.started = !1, this.failed = !1, this.hasFirstFrame = !1, this.presentedFrames = 0, this.lastStats = {
			decoded: 0,
			dropped: 0,
			presented: 0,
			at: this.now()
		}, this.fpsSamples = [], this.lastRtcStats = {
			at: 0,
			bytesReceived: 0
		}, this.rtcStatsInFlight = !1, this.lastDiagnostic = {
			state: "",
			at: 0
		};
	}
	async start({ whepUrl: e, token: t } = {}) {
		if (this.started) return;
		if (!e || !t) throw Error("WebRTC 媒体凭证缺失");
		this.startOptions = {
			whepUrl: e,
			token: t
		}, this.started = !0, this.token = String(t), this.controller = new AbortController();
		let n = new this.RTCPeerConnectionCtor();
		this.pc = n, n.addTransceiver("video", { direction: "recvonly" }), n.ontrack = (e) => {
			let t = e.streams?.[0] || new MediaStream([e.track]);
			this.video.srcObject = t, this.video.play?.().catch((e) => this.fail(e));
		}, n.onconnectionstatechange = () => {
			if (this.reportDiagnostic("peer_connection_state", {
				connectionState: n.connectionState || "",
				iceConnectionState: n.iceConnectionState || "",
				signalingState: n.signalingState || ""
			}), this.started) {
				if (n.connectionState === "disconnected") {
					this.deferDisconnectedFailure(n);
					return;
				}
				this.clearDisconnectedFailure(), n.connectionState === "connected" && (this.reconnectAttempts = 0), ["failed", "closed"].includes(n.connectionState) && this.fail(/* @__PURE__ */ Error(`WebRTC 连接${n.connectionState}`));
			}
		}, n.oniceconnectionstatechange = () => this.reportDiagnostic("ice_connection_state", {
			connectionState: n.connectionState || "",
			iceConnectionState: n.iceConnectionState || "",
			signalingState: n.signalingState || ""
		}), this.video.addEventListener("loadeddata", this.handleLoadedData), this.video.addEventListener("error", this.handleVideoError), this.video.addEventListener("playing", this.handlePlaying), this.video.addEventListener("waiting", this.handleWaiting), this.video.addEventListener("stalled", this.handleStalled), this.video.addEventListener("emptied", this.handleEmptied);
		let r = await n.createOffer();
		await n.setLocalDescription(r), await M(n);
		let i = await j({
			fetchFn: this.fetch,
			whepUrl: e,
			token: t,
			sdp: n.localDescription?.sdp || r.sdp,
			signal: this.controller.signal,
			retryDelayMs: 150,
			maxRetryDelayMs: 250,
			retryBackoffMultiplier: 1.35,
			sleepFn: this.sleep
		});
		if (!i.ok) throw Error(`WebRTC 媒体服务返回 ${i.status}`);
		let a = await i.text();
		if (!a.trim()) throw Error("WebRTC 媒体服务未返回会话描述");
		this.resourceUrl = A(e, i.headers.get("location")), await n.setRemoteDescription({
			type: "answer",
			sdp: a
		}), this.requestNextVideoFrame(), this.monitorTimer = this.setRepeatingTimer(() => this.monitorPlayback(), 250);
	}
	stop() {
		if (!this.started) return;
		this.started = !1, this.controller?.abort(), this.monitorTimer && this.clearRepeatingTimer(this.monitorTimer), this.clearDisconnectedFailure(), this.reconnectTimer != null && this.clearDelayTimer(this.reconnectTimer), this.frameCallbackId != null && typeof this.video.cancelVideoFrameCallback == "function" && this.video.cancelVideoFrameCallback(this.frameCallbackId);
		let e = this.resourceUrl, t = this.pc;
		this.pc = null, this.resourceUrl = "", this.monitorTimer = null, this.reconnectTimer = null, this.frameCallbackId = null, this.video.removeEventListener("loadeddata", this.handleLoadedData), this.video.removeEventListener("error", this.handleVideoError), this.video.removeEventListener("playing", this.handlePlaying), this.video.removeEventListener("waiting", this.handleWaiting), this.video.removeEventListener("stalled", this.handleStalled), this.video.removeEventListener("emptied", this.handleEmptied), this.video.srcObject = null;
		try {
			t?.close();
		} catch {}
		let n = this.token;
		this.token = "", e && this.fetch(e, {
			method: "DELETE",
			headers: { authorization: `Bearer ${n}` }
		}).catch(() => {});
	}
	requestNextVideoFrame() {
		!this.started || typeof this.video.requestVideoFrameCallback != "function" || (this.frameCallbackId = this.video.requestVideoFrameCallback((e, t = {}) => {
			this.started && (this.presentedFrames += 1, this.markFirstFrame(), this.onVideoFrame({
				presentedAt: Number(e || this.now()),
				presentedFrames: this.presentedFrames,
				mediaTime: Number(t.mediaTime || 0),
				expectedDisplayTime: Number(t.expectedDisplayTime || 0)
			}), this.requestNextVideoFrame());
		}));
	}
	monitorPlayback() {
		if (!this.started || this.failed) return;
		let e = this.video.getVideoPlaybackQuality?.(), t = this.now(), n = e ? Number(e.totalVideoFrames || 0) : this.presentedFrames, r = e ? Number(e.droppedVideoFrames || 0) : 0;
		Math.max(.001, (t - this.lastStats.at) / 1e3);
		let i = this.presentedFps(t), a = this.lastStats;
		this.lastStats = {
			decoded: n,
			dropped: r,
			presented: this.presentedFrames,
			at: t
		}, this.hasFirstFrame && n === a.decoded && this.presentedFrames === a.presented && this.reportDiagnostic("video_frames_idle", {
			decoded: n,
			presented: this.presentedFrames,
			readyState: Number(this.video.readyState || 0),
			paused: !!this.video.paused
		}), this.onStats({
			decoded: n,
			dropped: r,
			presented: this.presentedFrames,
			fps: i,
			bufferSeconds: 0,
			decoderBackend: "webrtc"
		}), this.collectRtcStats(t);
	}
	presentedFps(e) {
		for (this.fpsSamples.push({
			at: e,
			presented: this.presentedFrames
		}); this.fpsSamples.length > 1 && e - this.fpsSamples[0].at > 1e3;) this.fpsSamples.shift();
		let t = this.fpsSamples[0], n = Math.max(0, (e - t.at) / 1e3);
		return n > 0 ? Math.max(0, (this.presentedFrames - t.presented) / n) : 0;
	}
	async collectRtcStats(e = this.now()) {
		if (!(!this.started || this.rtcStatsInFlight || !this.pc?.getStats) && !(e - this.lastRtcStats.at < 1e3)) {
			this.rtcStatsInFlight = !0;
			try {
				let e = await this.pc.getStats();
				if (!this.started) return;
				let t = T(e, {
					at: this.now(),
					previous: this.lastRtcStats
				});
				if (!t) return;
				this.lastRtcStats = {
					...this.lastRtcStats,
					...t,
					at: t.at
				}, this.onStats({
					...t,
					decoderBackend: "webrtc"
				});
			} catch (e) {
				this.reportDiagnostic("webrtc_stats_error", { message: String(e?.message || e || "unknown") });
			} finally {
				this.rtcStatsInFlight = !1;
			}
		}
	}
	markFirstFrame() {
		!this.started || this.hasFirstFrame || this.failed || (this.hasFirstFrame = !0, this.onFirstFrame({
			decoderBackend: "webrtc",
			videoWidth: Number(this.video.videoWidth || 0),
			videoHeight: Number(this.video.videoHeight || 0)
		}));
	}
	fail(e) {
		this.failed || !this.started || (this.failed = !0, this.onError(e instanceof Error ? e : Error(String(e || "WebRTC 播放失败"))));
	}
	deferDisconnectedFailure(e) {
		if (this.disconnectTimer != null) return;
		let t = 8e3;
		this.reportDiagnostic("peer_connection_disconnected_grace", { graceMs: t }), this.disconnectTimer = this.setDelayTimer(() => {
			this.disconnectTimer = null, !(!this.started || this.failed || this.pc !== e || e.connectionState !== "disconnected") && this.retryDisconnectedPeerConnection();
		}, t);
	}
	retryDisconnectedPeerConnection() {
		if (this.reconnectAttempts >= 3 || !this.startOptions) {
			this.fail(/* @__PURE__ */ Error("WebRTC 连接持续中断（已自动重连 3 次）"));
			return;
		}
		this.reconnectAttempts += 1;
		let e = this.reconnectAttempts, t = [
			300,
			800,
			1500
		][e - 1] || 1500, n = this.startOptions;
		this.reportDiagnostic("peer_connection_reconnect", {
			attempt: e,
			maxAttempts: 3,
			delayMs: t
		}), this.stop(), this.reconnectTimer = this.setDelayTimer(() => {
			this.reconnectTimer = null, this.start(n).catch((e) => this.fail(e));
		}, t);
	}
	clearDisconnectedFailure() {
		this.disconnectTimer != null && (this.clearDelayTimer(this.disconnectTimer), this.disconnectTimer = null);
	}
	handleLoadedData = () => this.markFirstFrame();
	handleVideoError = () => this.fail(/* @__PURE__ */ Error("浏览器无法播放 WebRTC 视频"));
	handlePlaying = () => this.reportDiagnostic("video_playing", this.videoState());
	handleWaiting = () => this.reportDiagnostic("video_waiting", this.videoState());
	handleStalled = () => this.reportDiagnostic("video_stalled", this.videoState());
	handleEmptied = () => this.reportDiagnostic("video_emptied", this.videoState());
	videoState() {
		return {
			readyState: Number(this.video.readyState || 0),
			paused: !!this.video.paused,
			videoWidth: Number(this.video.videoWidth || 0),
			videoHeight: Number(this.video.videoHeight || 0)
		};
	}
	reportDiagnostic(e, t = {}) {
		let n = this.now(), r = `${e}:${JSON.stringify(t)}`;
		this.lastDiagnostic.state === r && n - this.lastDiagnostic.at < 5e3 || (this.lastDiagnostic = {
			state: r,
			at: n
		}, this.onStats({ diagnostic: {
			event: e,
			...t
		} }));
	}
};
function w(e) {
	return {
		"content-type": "application/sdp",
		authorization: `Bearer ${String(e || "").trim()}`
	};
}
function T(e, { at: t = Date.now(), previous: n = {} } = {}) {
	let r = O(e, n.rtcInboundReportId);
	if (!r) return null;
	let i = k(r.bytesReceived), a = k(r.packetsLost), o = k(r.framesDecoded), s = k(r.freezeCount), c = k(r.totalFreezesDuration) * 1e3, l = !!(n.rtcInboundReportId && n.rtcInboundReportId === r.rtcInboundReportId), u = k(n.at), d = l ? Math.max(1, Number(t) - u) : 0, f = Math.max(0, i - k(n.rtcBytesReceived ?? n.bytesReceived)), p = Math.max(0, a - k(n.rtcPacketsLost)), m = Math.max(0, o - k(n.rtcFramesDecoded)), h = Math.max(0, s - k(n.rtcFreezeCount)), g = Math.max(0, c - k(n.rtcTotalFreezeMs)), _ = u > 0 && l ? f * 8 / d / 1e3 : 0, v = k(r.totalDecodeTime), y = E(e, r);
	return {
		at: Number(t),
		rtcInboundReportId: r.rtcInboundReportId,
		rtcStatsWindowMs: u > 0 && l ? d : 0,
		rtcFramesDecoded: o,
		rtcFramesDecodedDelta: u > 0 && l ? m : 0,
		rtcFramesDropped: k(r.framesDropped),
		rtcFramesPerSecond: k(r.framesPerSecond),
		rtcPacketsLost: a,
		rtcPacketsLostDelta: u > 0 && l ? p : 0,
		rtcJitterMs: k(r.jitter) * 1e3,
		rtcBytesReceived: i,
		rtcBytesReceivedDelta: u > 0 && l ? f : 0,
		rtcReceiveMbps: _,
		rtcDecodeMsPerFrame: o > 0 ? v * 1e3 / o : 0,
		rtcFreezeCount: s,
		rtcFreezeCountDelta: u > 0 && l ? h : 0,
		rtcTotalFreezeMs: c,
		rtcTotalFreezeMsDelta: u > 0 && l ? g : 0,
		...y
	};
}
function E(e, t) {
	let n = /* @__PURE__ */ new Map();
	for (let [t, r] of e?.entries?.() || []) n.set(String(r?.id || t), r);
	let r = n.get(String(t?.transportId || "")), i = n.get(String(r?.selectedCandidatePairId || ""));
	if (!i || i.type !== "candidate-pair") return {};
	let a = n.get(String(i.localCandidateId || "")), o = n.get(String(i.remoteCandidateId || ""));
	return {
		...D("rtcIceProtocol", a?.protocol),
		...D("rtcIceLocalType", a?.candidateType),
		...D("rtcIceRemoteType", o?.candidateType),
		...D("rtcIcePairState", i?.state)
	};
}
function D(e, t) {
	let n = String(t || "").trim().toLowerCase();
	return n ? { [e]: n } : {};
}
function O(e, t = "") {
	let n = /* @__PURE__ */ new Map(), r = [];
	for (let [t, r] of e?.entries?.() || []) r?.type === "codec" && n.set(String(r.id || t), r);
	for (let [t, i] of e?.entries?.() || []) {
		let e = String(i?.kind || i?.mediaType || "").toLowerCase();
		if (i?.type !== "inbound-rtp" || e !== "video" || i.isRemote) continue;
		let a = String(i.id || t), o = n.get(String(i.codecId || "")), s = String(o?.mimeType || "").toLowerCase();
		r.push({
			...i,
			rtcInboundReportId: a,
			isRetransmission: /(?:\/rtx|\/red|\/ulpfec)$/.test(s)
		});
	}
	if (!r.length) return null;
	let i = r.find((e) => e.rtcInboundReportId === String(t || ""));
	if (i) return i;
	let a = r.filter((e) => !e.isRetransmission);
	return (a.length ? a : r).sort((e, t) => k(t.bytesReceived) - k(e.bytesReceived))[0];
}
function k(e) {
	let t = Number(e || 0);
	return Number.isFinite(t) ? t : 0;
}
function A(e, t) {
	if (!t) return "";
	let n = new URL(e), r = new URL(t, n), i = n.pathname.indexOf("/pc/");
	return i > 0 && String(t).startsWith("/") && (r.pathname = `${n.pathname.slice(0, i)}${r.pathname}`), r.toString();
}
async function j({ fetchFn: e, whepUrl: t, token: n, sdp: r, signal: i, availabilityTimeoutMs: a = 15e3, retryDelayMs: o = 250, maxRetryDelayMs: s = 1e3, retryBackoffMultiplier: c = 1.6, sleepFn: l = N, now: u = () => Date.now() } = {}) {
	let d = u() + Math.max(0, Number(a) || 0), f = () => e(t, {
		method: "POST",
		headers: w(n),
		body: r,
		signal: i
	}), p = Math.max(0, Number(o) || 0), m = Math.max(p, Number(s) || p), h = Math.max(1, Number(c) || 1), g = await f();
	for (; g.status === 404 && u() < d;) await l(p), g = await f(), p = Math.min(m, Math.ceil(p * h));
	return g;
}
function M(e, t = 3e3) {
	return e.iceGatheringState === "complete" ? Promise.resolve() : new Promise((n) => {
		let r = null, i = !1, a = () => {
			i || (i = !0, r && clearTimeout(r), e.removeEventListener?.("icegatheringstatechange", o), n());
		}, o = () => {
			e.iceGatheringState === "complete" && a();
		};
		e.addEventListener?.("icegatheringstatechange", o), !i && (r = setTimeout(a, t));
	});
}
function N(e) {
	return new Promise((t) => setTimeout(t, e));
}
//#endregion
//#region screen-client/direct-webrtc-player.js
var P = class {
	constructor({ video: e, onFirstFrame: t = () => {}, onStats: n = () => {}, onError: r = () => {}, RTCPeerConnectionCtor: i = globalThis.RTCPeerConnection, WebSocketCtor: a = globalThis.WebSocket, now: o = () => globalThis.performance?.now?.() || Date.now(), setRepeatingTimer: s = globalThis.setInterval.bind(globalThis), clearRepeatingTimer: c = globalThis.clearInterval.bind(globalThis) } = {}) {
		if (!e) throw Error("缺少实时投屏 video 元素");
		if (!i || !a) throw Error("当前浏览器不支持直连 WebRTC");
		this.video = e, this.onFirstFrame = t, this.onStats = n, this.onError = r, this.RTCPeerConnectionCtor = i, this.WebSocketCtor = a, this.now = o, this.setRepeatingTimer = s, this.clearRepeatingTimer = c, this.pc = null, this.signal = null, this.monitorTimer = null, this.started = !1, this.failed = !1, this.hasFirstFrame = !1, this.presentedFrames = 0, this.frameCallbackId = null, this.previousRtc = {};
	}
	async start({ signalUrl: e, token: t, iceServers: n = [] } = {}) {
		if (this.started) return;
		if (!e || !t) throw Error("直连 WebRTC 信令凭证缺失");
		this.started = !0;
		let r = new this.RTCPeerConnectionCtor({ iceServers: F(n) });
		this.pc = r, r.addTransceiver("video", { direction: "recvonly" }), r.ontrack = (e) => {
			let t = e.streams?.[0] || new MediaStream([e.track]);
			this.video.srcObject = t, this.video.play?.().catch((e) => this.fail(e));
		}, r.onconnectionstatechange = () => {
			let e = r.connectionState || "";
			this.onStats({ diagnostic: {
				event: "direct_peer_connection_state",
				connectionState: e,
				iceConnectionState: r.iceConnectionState || ""
			} }), this.started && ["failed", "closed"].includes(e) && this.fail(/* @__PURE__ */ Error(`WebRTC 连接${e}`));
		}, r.oniceconnectionstatechange = () => this.onStats({ diagnostic: {
			event: "direct_ice_connection_state",
			connectionState: r.connectionState || "",
			iceConnectionState: r.iceConnectionState || ""
		} }), this.video.addEventListener("loadeddata", this.handleLoadedData), this.video.addEventListener("error", this.handleVideoError), this.video.addEventListener("playing", this.handlePlaying), this.video.addEventListener("waiting", this.handleWaiting), this.video.addEventListener("stalled", this.handleStalled);
		let i = new this.WebSocketCtor(e, [String(t)]);
		this.signal = i, await I(i, 12e3);
		let a = await r.createOffer();
		await r.setLocalDescription(a), await M(r);
		let o = L(i, "answer");
		i.send(JSON.stringify({
			type: "offer",
			sdp: r.localDescription?.sdp || a.sdp
		}));
		let s = await o;
		await r.setRemoteDescription({
			type: "answer",
			sdp: s.sdp
		}), this.requestNextVideoFrame(), this.monitorTimer = this.setRepeatingTimer(() => this.monitorPlayback(), 250);
	}
	stop() {
		if (this.started) {
			this.started = !1, this.monitorTimer && this.clearRepeatingTimer(this.monitorTimer), this.frameCallbackId != null && typeof this.video.cancelVideoFrameCallback == "function" && this.video.cancelVideoFrameCallback(this.frameCallbackId), this.monitorTimer = null, this.frameCallbackId = null, this.video.removeEventListener("loadeddata", this.handleLoadedData), this.video.removeEventListener("error", this.handleVideoError), this.video.removeEventListener("playing", this.handlePlaying), this.video.removeEventListener("waiting", this.handleWaiting), this.video.removeEventListener("stalled", this.handleStalled);
			try {
				this.signal?.close(1e3, "browser_closed");
			} catch {}
			try {
				this.pc?.close();
			} catch {}
			this.signal = null, this.pc = null, this.video.srcObject = null;
		}
	}
	requestNextVideoFrame() {
		!this.started || typeof this.video.requestVideoFrameCallback != "function" || (this.frameCallbackId = this.video.requestVideoFrameCallback(() => {
			this.started && (this.presentedFrames += 1, this.markFirstFrame(), this.requestNextVideoFrame());
		}));
	}
	async monitorPlayback() {
		if (!(!this.started || this.failed || !this.pc?.getStats)) try {
			let e = T(await this.pc.getStats(), {
				at: this.now(),
				previous: this.previousRtc
			});
			e && (this.previousRtc = e, this.onStats({
				...e,
				decoderBackend: "direct_webrtc"
			}));
		} catch (e) {
			this.onStats({ diagnostic: {
				event: "direct_webrtc_stats_error",
				message: String(e?.message || e || "unknown")
			} });
		}
	}
	markFirstFrame() {
		!this.started || this.hasFirstFrame || this.failed || (this.hasFirstFrame = !0, this.onFirstFrame({
			decoderBackend: "direct_webrtc",
			videoWidth: Number(this.video.videoWidth || 0),
			videoHeight: Number(this.video.videoHeight || 0)
		}));
	}
	fail(e) {
		this.failed || !this.started || (this.failed = !0, this.onError(e instanceof Error ? e : Error(String(e || "直连 WebRTC 播放失败"))));
	}
	handleLoadedData = () => this.markFirstFrame();
	handleVideoError = () => this.fail(/* @__PURE__ */ Error("浏览器无法播放直连 WebRTC 视频"));
	handlePlaying = () => {};
	handleWaiting = () => {};
	handleStalled = () => {};
};
function F(e) {
	return Array.isArray(e) ? e.slice(0, 8).map((e) => ({
		urls: e?.urls,
		...e?.username ? { username: e.username } : {},
		...e?.credential ? { credential: e.credential } : {}
	})).filter((e) => e.urls) : [];
}
function I(e, t) {
	return e.readyState === 1 ? Promise.resolve() : new Promise((n, r) => {
		let i = setTimeout(() => {
			a(), r(/* @__PURE__ */ Error("direct_webrtc_signal_timeout"));
		}, t), a = () => {
			clearTimeout(i), e.removeEventListener?.("open", o), e.removeEventListener?.("error", s);
		}, o = () => {
			a(), n();
		}, s = (e) => {
			a(), r(e instanceof Error ? e : /* @__PURE__ */ Error("direct_webrtc_signal_error"));
		};
		e.addEventListener?.("open", o), e.addEventListener?.("error", s);
	});
}
function L(e, t) {
	return new Promise((n, r) => {
		let i = (e) => {
			try {
				let i = JSON.parse(e.data);
				i.type === t ? (s(), n(i)) : i.type === "error" && (s(), r(Error(i.message || "direct_webrtc_signal_error")));
			} catch (e) {
				s(), r(e);
			}
		}, a = () => {
			s(), r(/* @__PURE__ */ Error("direct_webrtc_signal_closed"));
		}, o = setTimeout(() => {
			s(), r(/* @__PURE__ */ Error(`direct_webrtc_${t}_timeout`));
		}, 15e3), s = () => {
			clearTimeout(o), e.removeEventListener?.("message", i), e.removeEventListener?.("close", a);
		};
		e.addEventListener?.("message", i), e.addEventListener?.("close", a);
	});
}
//#endregion
//#region screen-client/control-input.js
function R({ video: e, send: t, requestFrame: n = globalThis.requestAnimationFrame?.bind(globalThis) || ((e) => setTimeout(e, 16)), cancelFrame: r = globalThis.cancelAnimationFrame?.bind(globalThis) || clearTimeout }) {
	if (!e || typeof t != "function") throw Error("invalid_screen_control_input");
	let i = 0, a = null, o = null, s = null, c = (e) => t({
		...e,
		sequenceId: ++i
	}), l = (e) => ({
		type: e.type,
		pointerId: e.pointerId,
		clientX: e.clientX,
		clientY: e.clientY
	}), u = (t, n, r = !0) => {
		let i = z(e, n, {
			clampOutside: r,
			sourceSize: s
		});
		return i ? (c({
			type: "touch",
			action: t,
			pointerId: n.pointerId,
			...i
		}), !0) : !1;
	}, d = () => {
		o != null && r(o), o = null;
		let e = a;
		a = null, e && u("move", e);
	}, f = (t) => {
		t.preventDefault?.(), u("down", t, !1) && e.setPointerCapture?.(t.pointerId);
	}, p = (t) => {
		t.preventDefault?.(), !(e.hasPointerCapture && !e.hasPointerCapture(t.pointerId)) && (a = l(t), o ??= n(() => {
			o = null;
			let e = a;
			a = null, e && u("move", e);
		}));
	}, m = (t) => {
		t.preventDefault?.(), d(), u(t.type === "pointerup" ? "up" : "cancel", t), (!e.hasPointerCapture || e.hasPointerCapture(t.pointerId)) && e.releasePointerCapture?.(t.pointerId);
	}, h = [
		["pointerdown", f],
		["pointermove", p],
		["pointerup", m],
		["pointercancel", m]
	];
	for (let [t, n] of h) e.addEventListener(t, n);
	return {
		flush: d,
		setSourceSize(e, t) {
			let n = Math.max(0, Math.round(Number(e || 0))), r = Math.max(0, Math.round(Number(t || 0)));
			s = n && r ? {
				width: n,
				height: r
			} : null;
		},
		key(e) {
			c({
				type: "key",
				key: e
			});
		},
		text(e) {
			c({
				type: "text",
				text: String(e || "")
			});
		},
		destroy() {
			d();
			for (let [t, n] of h) e.removeEventListener(t, n);
		}
	};
}
function z(e, t, { clampOutside: n = !0, sourceSize: r = null } = {}) {
	let i = e.getBoundingClientRect(), a = Math.max(0, Math.round(Number(r?.width || e.videoWidth || 0))), o = Math.max(0, Math.round(Number(r?.height || e.videoHeight || 0)));
	if (!a || !o || !i.width || !i.height) return null;
	let s = a / o, c = i.width / i.height, l = s > c ? i.width : i.height * s, u = s > c ? i.width / s : i.height, d = (i.width - l) / 2, f = (i.height - u) / 2, p = Number(t.clientX) - i.left - d, m = Number(t.clientY) - i.top - f;
	if (!n && (p < 0 || m < 0 || p > l || m > u)) return null;
	let h = Math.max(0, Math.min(l, p)), g = Math.max(0, Math.min(u, m));
	return {
		x: Math.min(a - 1, Math.max(0, Math.round(h / l * a))),
		y: Math.min(o - 1, Math.max(0, Math.round(g / u * o))),
		videoWidth: a,
		videoHeight: o
	};
}
//#endregion
//#region screen-client/screen-transport.js
function B(e, t, n) {
	let r = new URL(String(e || globalThis.location?.origin || "http://127.0.0.1"));
	r.protocol = r.protocol === "https:" ? "wss:" : "ws:", r.search = "", r.hash = "";
	let i = encodeURIComponent(String(t || "")), a = new URL(r);
	a.pathname = `/realtime/v1/sessions/${i}/control`;
	let o = new URL(r);
	return o.pathname = `/realtime/v1/sessions/${i}/video`, {
		controlUrl: a.toString(),
		videoUrl: o.toString()
	};
}
function V(e = {}) {
	let t = e.WebSocketCtor || globalThis.WebSocket, n = e.onControl || (() => {}), r = e.onVideo || (() => {}), i = e.onOpen || (() => {}), a = e.onError || (() => {}), o = e.onClose || (() => {}), s = null, c = null, l = !1, u = (e = 1e3, t = "user_closed") => {
		l = !0;
		for (let n of [s, c]) n && n.readyState < 2 && n.close(e, t);
		s = null, c = null;
	};
	return {
		connect({ baseUrl: e, sessionId: d, browserToken: f, videoEnabled: p = !0 }) {
			u(), l = !1;
			let m = B(e, d, f), h = [String(f || "")].filter(Boolean);
			return s = new t(m.controlUrl, h), c = p ? new t(m.videoUrl, h) : null, c && (c.binaryType = "arraybuffer"), s.onopen = () => i("control"), c && (c.onopen = () => i("video")), s.onmessage = (e) => n(e.data), c && (c.onmessage = (e) => r(e.data)), s.onerror = (e) => a("control", e), c && (c.onerror = (e) => a("video", e)), s.onclose = (e) => {
				l || o("control", e);
			}, c && (c.onclose = (e) => {
				l || o("video", e);
			}), m;
		},
		send(e) {
			return s?.readyState === t.OPEN ? (s.send(JSON.stringify(e)), !0) : !1;
		},
		close: u,
		get sockets() {
			return {
				control: s,
				video: c
			};
		}
	};
}
//#endregion
//#region screen-client/main.js
function H(e = {}, t = "") {
	return ["webrtc", "direct_webrtc"].includes(e?.mode) ? {
		...e,
		...e.mode === "direct_webrtc" ? { token: String(t || "") } : {}
	} : { mode: "websocket" };
}
var U = class {
	constructor({ video: e, onStatus: t, onMetrics: n, relayBaseUrl: r = location.origin }) {
		if (!e) throw Error("缺少实时投屏 video 元素");
		this.video = e, this.onStatus = t || (() => {}), this.onMetrics = n || (() => {}), this.relayBaseUrl = r, this.transportClosed = !0, this.player = null, this.failureMessage = "", this.media = { mode: "websocket" }, this.channelMetadata = {}, this.lastStats = {}, this.controlSentAt = /* @__PURE__ */ new Map(), this.pendingVisualProbe = null, this.transportErrorChannel = "", this.playbackMetrics = G({ send: (e) => this.send(e) }), this.controlInput = R({
			video: e,
			send: (e) => this.sendControl(e)
		}), this.transport = V({
			onControl: (e) => this.consumeTransportData(e),
			onVideo: (e) => this.consumeTransportData(e),
			onError: (e) => this.handleTransportError(e),
			onClose: (e, t) => this.handleTransportClose(e, t)
		});
	}
	connect({ sessionId: e, browserToken: t, media: n = { mode: "websocket" } }) {
		this.disconnect(!1), this.transportClosed = !1, this.transportErrorChannel = "", this.media = H(n, t), this.emit("connecting", "正在连接手机画面"), this.transport.connect({
			baseUrl: this.relayBaseUrl,
			sessionId: e,
			browserToken: t,
			videoEnabled: !["webrtc", "direct_webrtc"].includes(this.media.mode)
		}), ["webrtc", "direct_webrtc"].includes(this.media.mode) && this.setupPlayer("h264");
	}
	consumeTransportData(e) {
		try {
			this.handleMessage({ data: e });
		} catch (e) {
			this.failPlayer(e);
		}
	}
	handleMessage(e) {
		if (typeof e.data == "string") {
			let t = JSON.parse(e.data);
			if (t.type === "screen_control_ack") {
				this.handleControlAcknowledgement(t);
				return;
			}
			if (t.type === "metadata" && (this.channelMetadata = {
				...this.channelMetadata,
				...t
			}, this.updateControlSourceSize(t), ["webrtc", "direct_webrtc"].includes(this.media.mode) || this.setupPlayer(t.codec)), t.type === "status") {
				if (t.metadata && (this.channelMetadata = {
					...this.channelMetadata,
					...t.metadata
				}, this.updateControlSourceSize(t.metadata)), t.status === "recovering") {
					this.cleanupPlayer(), this.emit("preparing", t.detail || "控制通道异常，正在自动恢复");
					return;
				}
				if (!["webrtc", "direct_webrtc"].includes(this.media.mode) && t.metadata?.codec && !this.player && this.setupPlayer(t.metadata.codec), t.status === "failed") {
					this.failureMessage = t.detail || "投屏启动失败", this.emit("failed", this.failureMessage, t.metadata || {});
					return;
				}
				if (t.status === "live" || t.status === "streaming") {
					let e = K(this.player?.hasFirstFrame);
					this.emit(e.status, e.detail, {
						...t.metadata,
						decoderBackend: ["webrtc", "direct_webrtc"].includes(this.media.mode) ? this.media.mode : "mse",
						...this.lastStats
					});
					return;
				}
				this.emit(t.status, t.detail || t.status, t.metadata || {});
			}
			return;
		}
		if (["webrtc", "direct_webrtc"].includes(this.media.mode)) return;
		this.player || this.setupPlayer("h264");
		let t = q(e.data);
		this.player.write(t.data);
	}
	setupPlayer(e) {
		if (!this.player) {
			if (this.media.mode === "webrtc") {
				this.player = new C({
					video: this.video,
					onFirstFrame: (e) => this.emit("live", "实时画面已连接", {
						...this.channelMetadata,
						...e,
						...this.lastStats
					}),
					onVideoFrame: (e) => this.handleVideoFrame(e),
					onStats: (e) => this.handlePlaybackStats(e),
					onError: (e) => this.failPlayer(e)
				}), this.player.start(this.media).catch((e) => this.failPlayer(e));
				return;
			}
			if (this.media.mode === "direct_webrtc") {
				this.player = new P({
					video: this.video,
					onFirstFrame: (e) => this.emit("live", "实时画面已连接", {
						...this.channelMetadata,
						...e,
						...this.lastStats
					}),
					onStats: (e) => this.handlePlaybackStats(e),
					onError: (e) => this.failPlayer(e)
				}), this.player.start(this.media).catch((e) => this.failPlayer(e));
				return;
			}
			if (e && !String(e).toLowerCase().includes("264") && e !== 1748121140) throw Error(`当前投屏只支持 H.264，收到 ${e}`);
			this.player = new S({
				video: this.video,
				onFirstFrame: (e) => {
					this.emit("live", "实时画面已连接", {
						...this.channelMetadata,
						...e,
						...this.lastStats
					});
				},
				onStats: (e) => this.handlePlaybackStats(e),
				onError: (e) => this.failPlayer(e)
			}), this.player.start();
		}
	}
	handlePlaybackStats(e) {
		if (e?.diagnostic) {
			this.send({
				type: "screen_playback_diagnostic",
				diagnostic: e.diagnostic
			});
			return;
		}
		this.lastStats = {
			...this.lastStats,
			...e
		}, this.video.dataset.screenFps = Number(e.fps || 0).toFixed(1), this.video.dataset.screenDecoded = String(e.decoded || 0), this.video.dataset.screenDropped = String(e.dropped || 0), this.video.dataset.screenPresented = String(e.presented || 0), this.video.dataset.screenBufferMs = String(Math.round(Number(e.bufferSeconds || 0) * 1e3)), this.onMetrics(this.lastStats), this.playbackMetrics.report(this.lastStats);
	}
	failPlayer(e) {
		this.failureMessage || (this.failureMessage = `视频播放失败：${e?.message || e || "浏览器不支持当前视频流"}`, this.emit("failed", this.failureMessage, {
			decoderBackend: ["webrtc", "direct_webrtc"].includes(this.media.mode) ? this.media.mode : "mse",
			...this.lastStats
		}), this.transport.close(1e3, "player_failed"));
	}
	send(e) {
		this.transport.send(e);
	}
	sendControl(e) {
		for (this.controlSentAt.set(e.sequenceId, {
			sentAt: globalThis.performance?.now?.() || Date.now(),
			control: e
		}); this.controlSentAt.size > 256;) this.controlSentAt.delete(this.controlSentAt.keys().next().value);
		this.send(e);
	}
	updateControlSourceSize(e = {}) {
		let t = Number(e.width || e.videoWidth || 0), n = Number(e.height || e.videoHeight || 0);
		t > 0 && n > 0 && this.controlInput.setSourceSize(t, n);
	}
	handleControlAcknowledgement(e) {
		let t = this.controlSentAt.get(e.sequenceId);
		if (this.controlSentAt.delete(e.sequenceId), e.status !== "injected" || !t) return;
		let n = globalThis.performance?.now?.() || Date.now();
		this.lastStats = {
			...this.lastStats,
			controlRttMs: Math.max(0, n - t.sentAt),
			agentControlMs: Math.max(0, Number(e.agentElapsedMs || 0))
		}, W(t.control, e) && (this.pendingVisualProbe = {
			sequenceId: Number(e.sequenceId || 0),
			action: String(e.action || "unknown"),
			sentAt: t.sentAt,
			acknowledgedAt: n
		}), this.video.dataset.screenControlRttMs = this.lastStats.controlRttMs.toFixed(1), this.video.dataset.screenAgentControlMs = this.lastStats.agentControlMs.toFixed(1), this.onMetrics(this.lastStats), this.playbackMetrics.report(this.lastStats);
	}
	handleVideoFrame(e = {}) {
		let t = this.pendingVisualProbe;
		if (!t) return;
		let n = Number(e.presentedAt || globalThis.performance?.now?.() || Date.now());
		n < t.acknowledgedAt || (this.pendingVisualProbe = null, this.handlePlaybackStats({ diagnostic: {
			event: "control_to_presented_frame",
			sequenceId: t.sequenceId,
			action: t.action,
			controlToPresentedMs: Math.max(0, n - t.sentAt),
			acknowledgementToPresentedMs: Math.max(0, n - t.acknowledgedAt),
			mediaTime: Number(e.mediaTime || 0),
			presentedFrames: Number(e.presentedFrames || 0)
		} }));
	}
	key(e) {
		this.controlInput.key(e);
	}
	text(e) {
		this.controlInput.text(e);
	}
	disconnect(e = !0) {
		this.failureMessage = "", this.transportClosed = !0, e && this.transport.close(1e3, "user_closed"), this.cleanupPlayer();
	}
	handleTransportError(e) {
		this.transportClosed || (this.transportErrorChannel = e || "control");
	}
	handleTransportClose(e = "control", t = {}) {
		if (this.transportClosed) return;
		this.transportClosed = !0;
		let n = (e || this.transportErrorChannel || "control") === "control" ? "控制通道" : "视频通道", r = Number(t?.code || 0), i = String(t?.reason || "").trim(), a = this.failureMessage || `${n}连接失败${r ? `（${r}${i ? `：${i}` : ""}）` : ""}`;
		this.transport.close(1e3, "peer_closed"), this.cleanupPlayer(), this.emit(this.failureMessage ? "failed" : "closed", a);
	}
	destroy() {
		this.disconnect(), this.controlInput.destroy();
	}
	cleanupPlayer() {
		this.player?.stop(), this.player = null, this.lastStats = {}, this.channelMetadata = {}, this.media = { mode: "websocket" }, this.controlInput.setSourceSize(0, 0), this.controlSentAt.clear(), this.pendingVisualProbe = null, this.playbackMetrics.reset();
	}
	emit(e, t, n = {}) {
		this.onStatus({
			status: e,
			detail: t,
			metadata: n
		});
	}
};
function W(e = {}, t = {}) {
	return e?.type === "touch" ? e.action === "up" && t.action === "up" : t.action !== "move";
}
function G({ send: e = () => !1, now: t = () => globalThis.performance?.now?.() || Date.now(), intervalMs: n = 5e3 } = {}) {
	let r = -Infinity, i = Math.max(1e3, Number(n || 5e3));
	return {
		report(n = {}) {
			let a = t();
			if (a - r < i) return !1;
			let o = {
				fps: Number(n.fps || 0),
				decoded: Number(n.decoded || 0),
				dropped: Number(n.dropped || 0),
				presented: Number(n.presented || 0),
				bufferSeconds: Number(n.bufferSeconds || 0),
				controlRttMs: Number(n.controlRttMs || 0),
				agentControlMs: Number(n.agentControlMs || 0)
			};
			for (let e of [
				"rtcStatsWindowMs",
				"rtcFramesDecoded",
				"rtcFramesDecodedDelta",
				"rtcFramesDropped",
				"rtcFramesPerSecond",
				"rtcPacketsLost",
				"rtcPacketsLostDelta",
				"rtcJitterMs",
				"rtcBytesReceived",
				"rtcBytesReceivedDelta",
				"rtcReceiveMbps",
				"rtcDecodeMsPerFrame",
				"rtcFreezeCount",
				"rtcFreezeCountDelta",
				"rtcTotalFreezeMs",
				"rtcTotalFreezeMsDelta"
			]) n[e] !== void 0 && n[e] !== null && (o[e] = Number(n[e] || 0));
			for (let e of [
				"rtcIceProtocol",
				"rtcIceLocalType",
				"rtcIceRemoteType",
				"rtcIcePairState"
			]) n[e] !== void 0 && n[e] !== null && (o[e] = String(n[e] || "").slice(0, 24));
			return e({
				type: "screen_playback_metrics",
				metrics: o
			}) === !1 ? !1 : (r = a, !0);
		},
		reset() {
			r = -Infinity;
		}
	};
}
function K(e = !1) {
	return e ? {
		status: "live",
		detail: "实时画面已连接"
	} : {
		status: "preparing",
		detail: "执行器已连接，正在等待手机首帧"
	};
}
function q(e) {
	let t = new DataView(e), n = t.getUint8(0), r = t.getUint8(1) === 1, i = t.getBigInt64(2, !1), a = new Uint8Array(e, 10);
	return n === 0 ? {
		type: "configuration",
		data: a
	} : {
		type: "data",
		keyframe: r,
		pts: i === -1n ? void 0 : i,
		data: a
	};
}
window.PhoneCloudScreenController = U;
//#endregion
export { U as PhoneCloudScreenController, G as createPlaybackMetricsReporter, q as decodeVideoPacket, K as liveScreenPlaybackStatus, H as normalizeScreenPlayerMedia };
