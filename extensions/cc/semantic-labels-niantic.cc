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

#include "semantic-labels-niantic.h"
#include "load-spz.h"

namespace spz {
namespace {

constexpr uint32_t kFixedHeaderBytes = 12u;  // version(4) + numLabels(4) + channelCount(1) + compression(1) + reserved(2)

template <class T>
bool readExact(std::istream& is, T& out) {
  return static_cast<bool>(is.read(reinterpret_cast<char*>(&out), sizeof(T)));
}

}  // namespace

SpzExtensionSemanticLabelsNiantic::SpzExtensionSemanticLabelsNiantic()
    : SpzExtensionBase(SpzExtensionType::SPZ_NIANTIC_semantic_labels) {}

uint32_t SpzExtensionSemanticLabelsNiantic::payloadBytes() const {
  // For Zstd, the on-disk payload size is only known after compression.
  // Return a best-effort estimate using the raw label size; write() emits the
  // accurate byteLength independently from the compressed blob.
  return kFixedHeaderBytes + static_cast<uint32_t>(labels.size());
}

void SpzExtensionSemanticLabelsNiantic::write(std::ostream& os) const {
  std::vector<uint8_t> blob;
  Compression effectiveCompression = compression;
  if (compression == Compression::Zstd) {
    if (!spz::compressZstd(labels.data(), labels.size(), &blob)) {
      SpzLog("[SPZ WARNING] SemanticLabelsNiantic zstd encode failed; writing raw");
      effectiveCompression = Compression::None;
      blob.assign(labels.begin(), labels.end());
    }
  } else {
    blob.assign(labels.begin(), labels.end());
  }

  const uint32_t t = static_cast<uint32_t>(extensionType);
  const uint32_t len = kFixedHeaderBytes + static_cast<uint32_t>(blob.size());
  const uint32_t version = payloadVersion;
  const uint32_t numLabels = static_cast<uint32_t>(labels.size());
  const uint8_t channels = channelCount;
  const uint8_t comp = static_cast<uint8_t>(effectiveCompression);
  const uint8_t reserved[2] = {0, 0};

  SpzLog("[SPZ] Writing extension: SemanticLabelsNiantic (numLabels=%u, channelCount=%u, "
         "compression=%u, blobBytes=%u)",
         static_cast<unsigned>(numLabels), static_cast<unsigned>(channels),
         static_cast<unsigned>(comp), static_cast<unsigned>(blob.size()));

  os.write(reinterpret_cast<const char*>(&t), sizeof(t));
  os.write(reinterpret_cast<const char*>(&len), sizeof(len));
  os.write(reinterpret_cast<const char*>(&version), sizeof(version));
  os.write(reinterpret_cast<const char*>(&numLabels), sizeof(numLabels));
  os.write(reinterpret_cast<const char*>(&channels), sizeof(channels));
  os.write(reinterpret_cast<const char*>(&comp), sizeof(comp));
  os.write(reinterpret_cast<const char*>(reserved), sizeof(reserved));
  if (!blob.empty())
    os.write(reinterpret_cast<const char*>(blob.data()),
             static_cast<std::streamsize>(blob.size()));
}

std::optional<SpzExtensionBasePtr> SpzExtensionSemanticLabelsNiantic::read(std::istream& is) {
  SpzLog("[SPZ] Found extension: SemanticLabelsNiantic");
  auto rec = std::make_shared<SpzExtensionSemanticLabelsNiantic>();

  uint32_t version = 0;
  uint32_t numLabels = 0;
  uint8_t channelCount = 0;
  uint8_t compression = 0;
  uint8_t reserved[2] = {0, 0};

  if (!readExact(is, version) || !readExact(is, numLabels) ||
      !readExact(is, channelCount) || !readExact(is, compression) ||
      !is.read(reinterpret_cast<char*>(reserved), sizeof(reserved))) {
    SpzLog("[SPZ ERROR] Failed to read SemanticLabelsNiantic header");
    return std::nullopt;
  }

  if (version != SpzExtensionSemanticLabelsNiantic::kPayloadVersion) {
    SpzLog("[SPZ WARNING] SemanticLabelsNiantic payload version %u not understood (expected %u)",
           static_cast<unsigned>(version),
           static_cast<unsigned>(SpzExtensionSemanticLabelsNiantic::kPayloadVersion));
    return std::nullopt;
  }
  if (channelCount == 0 || channelCount > 8) {
    SpzLog("[SPZ ERROR] SemanticLabelsNiantic channelCount %u out of range (1..8)",
           static_cast<unsigned>(channelCount));
    return std::nullopt;
  }

  // Read the rest of the payload as the blob (raw or compressed).
  std::vector<uint8_t> blob{
      std::istreambuf_iterator<char>(is), std::istreambuf_iterator<char>()};

  rec->payloadVersion = version;
  rec->channelCount = channelCount;
  rec->compression = static_cast<Compression>(compression);

  switch (rec->compression) {
    case Compression::None: {
      if (blob.size() != numLabels) {
        SpzLog("[SPZ ERROR] SemanticLabelsNiantic raw blob size %zu != numLabels %u",
               blob.size(), static_cast<unsigned>(numLabels));
        return std::nullopt;
      }
      rec->labels = std::move(blob);
      break;
    }
    case Compression::Zstd: {
      if (!spz::decompressZstd(blob.data(), blob.size(), &rec->labels) ||
          rec->labels.size() != numLabels) {
        SpzLog("[SPZ ERROR] SemanticLabelsNiantic zstd decode failed (compressed=%zu, expected=%u)",
               blob.size(), static_cast<unsigned>(numLabels));
        return std::nullopt;
      }
      break;
    }
    default:
      SpzLog("[SPZ ERROR] SemanticLabelsNiantic unknown compression id %u",
             static_cast<unsigned>(compression));
      return std::nullopt;
  }

  return std::optional{std::move(rec)};
}

SpzExtensionType SpzExtensionSemanticLabelsNiantic::type() {
  return SpzExtensionType::SPZ_NIANTIC_semantic_labels;
}

SpzExtensionBase* SpzExtensionSemanticLabelsNiantic::copyAsRawData() const {
  return new SpzExtensionSemanticLabelsNiantic(*this);
}

std::optional<SpzExtensionBasePtr> SpzExtensionSemanticLabelsNiantic::tryReadFromPly(
    std::istream& /*in*/, const std::unordered_set<std::string>& /*elementNames*/) const {
  return std::nullopt;
}

void SpzExtensionSemanticLabelsNiantic::writePlyHeader(std::ostream& /*out*/) const {}
void SpzExtensionSemanticLabelsNiantic::writePlyData(std::ostream& /*out*/) const {}

}  // namespace spz
