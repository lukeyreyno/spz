/*
MIT License

Copyright (c) 2026 Niantic Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

#ifndef SPZ_SEMANTIC_LABELS_NIANTIC_H_
#define SPZ_SEMANTIC_LABELS_NIANTIC_H_

#include "splat-extensions.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace spz {

// Experimental: a per-gaussian uint8 label, parallel to the cloud's gaussian
// array. Each byte packs up to 8 boolean channels (bit i = channel i flag).
// `channelCount` records how many bits are meaningful; bits at index
// >= channelCount must be zero.
//
// The label blob is always Zstd-compressed inside the extension payload.
// Readers that do not know this extension still skip the whole record via the
// outer [u32 type][u32 byteLength] envelope, so compression is transparent to
// them.
struct SpzExtensionSemanticLabelsNiantic : public SpzExtensionBase {
  static constexpr uint32_t kPayloadVersion = 1;

  uint32_t payloadVersion = kPayloadVersion;
  uint8_t channelCount = 8;             // 1..8
  std::vector<uint8_t> labels;          // size should equal cloud.numPoints

  SpzExtensionSemanticLabelsNiantic();
  uint32_t payloadBytes() const override;
  void write(std::ostream& os) const override;
  SpzExtensionBase* copyAsRawData() const override;

  // PLY round-trip is not supported for this experimental extension.
  std::optional<std::shared_ptr<SpzExtensionBase>> tryReadFromPly(
      std::istream& in, const std::unordered_set<std::string>& elementNames) const override;
  void writePlyHeader(std::ostream& out) const override;
  void writePlyData(std::ostream& out) const override;

  static std::optional<SpzExtensionBasePtr> read(std::istream& is);
  static SpzExtensionType type();
};

}  // namespace spz

#endif  // SPZ_SEMANTIC_LABELS_NIANTIC_H_
