//! flash.display.BitmapData object

use super::matrix::object_to_matrix;
use crate::avm1::function::{Executable, FunctionObject};
use crate::avm1::globals::color_transform::ColorTransformObject;
use crate::avm1::object::bitmap_data::BitmapDataObject;
use crate::avm1::property_decl::{define_properties_on, Declaration};
use crate::avm1::{Activation, Error, Object, TObject, Value};
use crate::bitmap::bitmap_data::{BitmapDataDrawError, IBitmapDrawable};
use crate::bitmap::bitmap_data::{ChannelOptions, ThresholdOperation};
use crate::bitmap::{is_size_valid, operations};
use crate::character::Character;
use crate::display_object::TDisplayObject;
use crate::swf::BlendMode;
use crate::{avm1_stub, avm_error};
use gc_arena::MutationContext;
use ruffle_render::transform::Transform;
use std::str::FromStr;

const PROTO_DECLS: &[Declaration] = declare_properties! {
    "height" => property(height);
    "width" => property(width);
    "transparent" => property(get_transparent);
    "rectangle" => property(get_rectangle);
    "getPixel" => method(get_pixel);
    "getPixel32" => method(get_pixel32);
    "setPixel" => method(set_pixel);
    "setPixel32" => method(set_pixel32);
    "copyChannel" => method(copy_channel);
    "fillRect" => method(fill_rect);
    "clone" => method(clone);
    "dispose" => method(dispose);
    "floodFill" => method(flood_fill);
    "noise" => method(noise);
    "colorTransform" => method(color_transform);
    "getColorBoundsRect" => method(get_color_bounds_rect);
    "perlinNoise" => method(perlin_noise);
    "applyFilter" => method(apply_filter);
    "draw" => method(draw);
    "hitTest" => method(hit_test);
    "generateFilterRect" => method(generate_filter_rect);
    "copyPixels" => method(copy_pixels);
    "merge" => method(merge);
    "paletteMap" => method(palette_map);
    "pixelDissolve" => method(pixel_dissolve);
    "scroll" => method(scroll);
    "threshold" => method(threshold);
    "compare" => method(compare);
};

const OBJECT_DECLS: &[Declaration] = declare_properties! {
    "loadBitmap" => method(load_bitmap);
};

pub fn constructor<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let width = args.get(0).unwrap_or(&0.into()).coerce_to_i32(activation)? as u32;

    let height = args.get(1).unwrap_or(&0.into()).coerce_to_i32(activation)? as u32;

    let transparency = args
        .get(2)
        .unwrap_or(&true.into())
        .as_bool(activation.swf_version());

    let fill_color = args
        .get(3)
        .unwrap_or(&(-1).into())
        .coerce_to_i32(activation)?;

    if !is_size_valid(activation.swf_version(), width, height) {
        tracing::warn!("Invalid BitmapData size: {}x{}", width, height);
        return Ok(Value::Undefined);
    }

    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        bitmap_data
            .bitmap_data()
            .write(activation.context.gc_context)
            .init_pixels(width, height, transparency, fill_color);
    }

    Ok(this.into())
}

pub fn height<'gc>(
    _activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            return Ok(bitmap_data.bitmap_data().read().height().into());
        }
    }

    Ok((-1).into())
}

pub fn width<'gc>(
    _activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            return Ok(bitmap_data.bitmap_data().read().width().into());
        }
    }

    Ok((-1).into())
}

pub fn get_transparent<'gc>(
    _activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            return Ok(bitmap_data.bitmap_data_wrapper().transparency().into());
        }
    }

    Ok((-1).into())
}

pub fn get_rectangle<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let proto = activation.context.avm1.prototypes().rectangle_constructor;
            let rect = proto.construct(
                activation,
                &[
                    0.into(),
                    0.into(),
                    bitmap_data.width().into(),
                    bitmap_data.height().into(),
                ],
            )?;
            return Ok(rect);
        }
    }

    Ok((-1).into())
}

pub fn get_pixel<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            if let (Some(x_val), Some(y_val)) = (args.get(0), args.get(1)) {
                let x = x_val.coerce_to_u32(activation)?;
                let y = y_val.coerce_to_u32(activation)?;
                let col = operations::get_pixel(bitmap_data.bitmap_data_wrapper(), x, y);
                return Ok(col.into());
            }
        }
    }

    Ok((-1).into())
}

pub fn get_pixel32<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            if let (Some(x_val), Some(y_val)) = (args.get(0), args.get(1)) {
                let x = x_val.coerce_to_u32(activation)?;
                let y = y_val.coerce_to_u32(activation)?;
                let col = operations::get_pixel32(bitmap_data.bitmap_data_wrapper(), x, y);
                return Ok(col.into());
            }
        }
    }

    Ok((-1).into())
}

pub fn set_pixel<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            if let (Some(x_val), Some(y_val), Some(color_val)) =
                (args.get(0), args.get(1), args.get(2))
            {
                let x = x_val.coerce_to_u32(activation)?;
                let y = y_val.coerce_to_u32(activation)?;
                let color = color_val.coerce_to_i32(activation)?;

                operations::set_pixel(
                    &mut activation.context,
                    bitmap_data.bitmap_data_wrapper(),
                    x,
                    y,
                    color.into(),
                );

                return Ok(Value::Undefined);
            }
        }
    }

    Ok((-1).into())
}

pub fn set_pixel32<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            if let (Some(x_val), Some(y_val), Some(color_val)) =
                (args.get(0), args.get(1), args.get(2))
            {
                let x = x_val.coerce_to_u32(activation)?;
                let y = y_val.coerce_to_u32(activation)?;
                let color = color_val.coerce_to_i32(activation)?;

                operations::set_pixel32(
                    &mut activation.context,
                    bitmap_data.bitmap_data_wrapper(),
                    x,
                    y,
                    color,
                );
            }

            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn copy_channel<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let source_bitmap = args
        .get(0)
        .unwrap_or(&Value::Undefined)
        .coerce_to_object(activation);

    let source_rect = args
        .get(1)
        .unwrap_or(&Value::Undefined)
        .coerce_to_object(activation);

    let dest_point = args
        .get(2)
        .unwrap_or(&Value::Undefined)
        .coerce_to_object(activation);

    let source_channel = args
        .get(3)
        .unwrap_or(&Value::Undefined)
        .coerce_to_i32(activation)?;

    let dest_channel = args
        .get(4)
        .unwrap_or(&Value::Undefined)
        .coerce_to_i32(activation)?;

    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            if let Some(source_bitmap) = source_bitmap.as_bitmap_data_object() {
                //TODO: what if source is disposed
                let min_x = dest_point
                    .get("x", activation)?
                    .coerce_to_u32(activation)?
                    .min(bitmap_data.bitmap_data().read().width());
                let min_y = dest_point
                    .get("y", activation)?
                    .coerce_to_u32(activation)?
                    .min(bitmap_data.bitmap_data().read().height());

                let src_min_x = source_rect
                    .get("x", activation)?
                    .coerce_to_u32(activation)?;
                let src_min_y = source_rect
                    .get("y", activation)?
                    .coerce_to_u32(activation)?;
                let src_width = source_rect
                    .get("width", activation)?
                    .coerce_to_u32(activation)?;
                let src_height = source_rect
                    .get("height", activation)?
                    .coerce_to_u32(activation)?;

                operations::copy_channel(
                    &mut activation.context,
                    bitmap_data.bitmap_data_wrapper(),
                    (min_x, min_y),
                    (src_min_x, src_min_y, src_width, src_height),
                    source_bitmap.bitmap_data_wrapper(),
                    source_channel,
                    dest_channel,
                );
            }

            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn fill_rect<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let rectangle = args
        .get(0)
        .unwrap_or(&Value::Undefined)
        .coerce_to_object(activation);

    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            if let Some(color_val) = args.get(1) {
                let color = color_val.coerce_to_i32(activation)?;

                let x = rectangle.get("x", activation)?.coerce_to_i32(activation)?;
                let y = rectangle.get("y", activation)?.coerce_to_i32(activation)?;
                let width = rectangle
                    .get("width", activation)?
                    .coerce_to_i32(activation)?;
                let height = rectangle
                    .get("height", activation)?
                    .coerce_to_i32(activation)?;

                operations::fill_rect(
                    &mut activation.context,
                    bitmap_data.bitmap_data_wrapper(),
                    x,
                    y,
                    width,
                    height,
                    color,
                );
            }
            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn clone<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let new_bitmap_data = operations::clone(bitmap_data.bitmap_data_wrapper());
            let new_bitmap_data = BitmapDataObject::with_bitmap_data(
                activation.context.gc_context,
                activation.context.avm1.prototypes().bitmap_data,
                new_bitmap_data,
            );

            return Ok(new_bitmap_data.into());
        }
    }

    Ok((-1).into())
}

pub fn dispose<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            bitmap_data.dispose(&mut activation.context);
            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn flood_fill<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            if let (Some(x_val), Some(y_val), Some(color_val)) =
                (args.get(0), args.get(1), args.get(2))
            {
                let x = x_val.coerce_to_u32(activation)?;
                let y = y_val.coerce_to_u32(activation)?;
                let color = color_val.coerce_to_i32(activation)?;

                operations::flood_fill(
                    &mut activation.context,
                    bitmap_data.bitmap_data_wrapper(),
                    x,
                    y,
                    color,
                );
            }
            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn noise<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let low = args.get(1).unwrap_or(&0.into()).coerce_to_u32(activation)? as u8;

    let high = args
        .get(2)
        .unwrap_or(&0xFF.into())
        .coerce_to_u32(activation)? as u8;

    let channel_options = if let Some(c) = args.get(3) {
        ChannelOptions::from_bits_truncate(c.coerce_to_u32(activation)? as u8)
    } else {
        ChannelOptions::RGB
    };

    let gray_scale = args
        .get(4)
        .unwrap_or(&false.into())
        .as_bool(activation.swf_version());

    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            if let Some(random_seed_val) = args.get(0) {
                let random_seed = random_seed_val.coerce_to_i32(activation)?;
                operations::noise(
                    &mut activation.context,
                    bitmap_data.bitmap_data_wrapper(),
                    random_seed,
                    low,
                    high.max(low),
                    channel_options,
                    gray_scale,
                )
            }

            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn draw<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let matrix = args
                .get(1)
                .map(|o| o.coerce_to_object(activation))
                .and_then(|o| object_to_matrix(o, activation).ok())
                .unwrap_or_default();

            let color_transform = args
                .get(2)
                .and_then(|v| ColorTransformObject::cast(*v))
                .map(|color_transform| color_transform.read().clone().into())
                .unwrap_or_default();

            let mut blend_mode = BlendMode::Normal;
            if let Some(mode) = args.get(3) {
                if let Ok(mode) =
                    BlendMode::from_str(&mode.coerce_to_string(activation)?.to_string())
                {
                    blend_mode = mode;
                } else if let Ok(Some(mode)) = mode.coerce_to_u8(activation).map(BlendMode::from_u8)
                {
                    blend_mode = mode;
                } else {
                    tracing::error!("Unknown blend mode {:?}", mode);
                }
            }

            if args.get(4).is_some() {
                avm1_stub!(activation, "BitmapData", "draw", "with clip rect");
            }
            let smoothing = args
                .get(5)
                .unwrap_or(&false.into())
                .as_bool(activation.swf_version());

            let source = args
                .get(0)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);
            let source = if let Some(source_object) = source.as_display_object() {
                IBitmapDrawable::DisplayObject(source_object)
            } else if let Some(source_bitmap) = source.as_bitmap_data_object() {
                IBitmapDrawable::BitmapData(source_bitmap.bitmap_data_wrapper())
            } else {
                avm_error!(
                    activation,
                    "BitmapData.draw: Unexpected source {:?} {:?}",
                    source,
                    args.get(0)
                );
                return Ok(Value::Undefined);
            };

            // Do this last, so that we only call `overwrite_cpu_pixels_from_gpu`
            // if we're actually going to draw something.
            let quality = activation.context.stage.quality();
            match operations::draw(
                &mut activation.context,
                bitmap_data.bitmap_data_wrapper(),
                source,
                Transform {
                    matrix,
                    color_transform,
                },
                smoothing,
                blend_mode,
                None,
                quality,
            ) {
                Ok(()) => {}
                Err(BitmapDataDrawError::Unimplemented) => {
                    avm_error!(
                        activation,
                        "Render backend does not support BitmapData.draw"
                    );
                }
            }
            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn apply_filter<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    avm1_stub!(activation, "BitmapData", "applyFilter");
    Ok((-1).into())
}

pub fn generate_filter_rect<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            avm1_stub!(activation, "BitmapData", "generateFilterRect");
            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn color_transform<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            if let [rectangle, color_transform, ..] = args {
                // TODO: Re-use `object_to_rectangle` in `movie_clip.rs`.
                let rectangle = rectangle.coerce_to_object(activation);
                let x = rectangle.get("x", activation)?.coerce_to_f64(activation)? as i32;
                let y = rectangle.get("y", activation)?.coerce_to_f64(activation)? as i32;
                let width = rectangle
                    .get("width", activation)?
                    .coerce_to_f64(activation)? as i32;
                let height = rectangle
                    .get("height", activation)?
                    .coerce_to_f64(activation)? as i32;

                let x_min = x.max(0) as u32;
                let x_max = (x + width) as u32;
                let y_min = y.max(0) as u32;
                let y_max = (y + height) as u32;

                let color_transform = match ColorTransformObject::cast(*color_transform) {
                    Some(color_transform) => color_transform.read().clone(),
                    None => return Ok((-3).into()),
                };

                operations::color_transform(
                    &mut activation.context,
                    bitmap_data.bitmap_data_wrapper(),
                    x_min,
                    y_min,
                    x_max,
                    y_max,
                    &color_transform.into(),
                );
            }
        }
    }

    Ok((-1).into())
}

pub fn get_color_bounds_rect<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let find_color = args
                .get(2)
                .unwrap_or(&true.into())
                .as_bool(activation.swf_version());

            if let (Some(mask_val), Some(color_val)) = (args.get(0), args.get(1)) {
                let mask = mask_val.coerce_to_i32(activation)?;
                let color = color_val.coerce_to_i32(activation)?;

                let (x, y, w, h) = operations::color_bounds_rect(
                    bitmap_data.bitmap_data_wrapper(),
                    find_color,
                    mask,
                    color,
                );

                let proto = activation.context.avm1.prototypes().rectangle_constructor;
                let rect =
                    proto.construct(activation, &[x.into(), y.into(), w.into(), h.into()])?;
                return Ok(rect);
            }
        }
    }

    Ok((-1).into())
}

pub fn perlin_noise<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let base_x = args
                .get(0)
                .unwrap_or(&Value::Undefined)
                .coerce_to_f64(activation)?;
            let base_y = args
                .get(1)
                .unwrap_or(&Value::Undefined)
                .coerce_to_f64(activation)?;
            let num_octaves = args
                .get(2)
                .unwrap_or(&Value::Undefined)
                .coerce_to_u32(activation)? as usize;
            let seed = args
                .get(3)
                .unwrap_or(&Value::Undefined)
                .coerce_to_i32(activation)? as i64;
            let stitch = args
                .get(4)
                .unwrap_or(&Value::Undefined)
                .as_bool(activation.swf_version());
            let fractal_noise = args
                .get(5)
                .unwrap_or(&Value::Undefined)
                .as_bool(activation.swf_version());
            let channel_options = if let Some(c) = args.get(6) {
                ChannelOptions::from_bits_truncate(c.coerce_to_i16(activation)? as u8)
            } else {
                ChannelOptions::RGB
            };
            let grayscale = args
                .get(7)
                .unwrap_or(&Value::Undefined)
                .as_bool(activation.swf_version());
            let offsets = args
                .get(8)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let octave_offsets: Result<Vec<_>, Error<'gc>> = (0..num_octaves)
                .map(|i| {
                    if let Value::Object(e) = offsets.get_element(activation, i as i32) {
                        let x = e.get("x", activation)?.coerce_to_f64(activation)?;
                        let y = e.get("y", activation)?.coerce_to_f64(activation)?;
                        Ok((x, y))
                    } else {
                        Ok((0.0, 0.0))
                    }
                })
                .collect();
            let octave_offsets = octave_offsets?;

            operations::perlin_noise(
                &mut activation.context,
                bitmap_data.bitmap_data_wrapper(),
                (base_x, base_y),
                num_octaves,
                seed,
                stitch,
                fractal_noise,
                channel_options,
                grayscale,
                octave_offsets,
            );
        }
    }

    Ok((-1).into())
}

pub fn hit_test<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let first_point = args
                .get(0)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);
            let top_left = if let (Some(x), Some(y)) = (
                first_point.get_local_stored("x", activation),
                first_point.get_local_stored("y", activation),
            ) {
                (x.coerce_to_i32(activation)?, y.coerce_to_i32(activation)?)
            } else {
                // Despite the AS docs saying this function returns `Boolean`, it returns a negative int on error conditions.
                // Invalid `firstPoint`.
                return Ok((-2).into());
            };
            let source_threshold = args
                .get(1)
                .unwrap_or(&Value::Undefined)
                .coerce_to_u32(activation)?;
            let compare_object = args
                .get(2)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            // Overload based on the object we are hit-testing against.
            // BitmapData vs. BitmapData
            if let Some(other_bmd) = compare_object.as_bitmap_data_object() {
                if other_bmd.disposed() {
                    return Ok((-3).into());
                }

                let second_point = args
                    .get(3)
                    .unwrap_or(&Value::Undefined)
                    .coerce_to_object(activation);
                let second_point = if let (Some(x), Some(y)) = (
                    second_point.get_local_stored("x", activation),
                    second_point.get_local_stored("y", activation),
                ) {
                    (x.coerce_to_i32(activation)?, y.coerce_to_i32(activation)?)
                } else {
                    // Invalid `secondPoint`.
                    return Ok((-4).into());
                };
                let second_threshold = args
                    .get(4)
                    .unwrap_or(&Value::Undefined)
                    .coerce_to_u32(activation)?;

                let result = operations::hit_test_bitmapdata(
                    bitmap_data.bitmap_data_wrapper(),
                    top_left,
                    source_threshold,
                    other_bmd.bitmap_data_wrapper(),
                    second_point,
                    second_threshold,
                );
                return Ok(Value::Bool(result));
            } else {
                // Determine what kind of Object we have, point or rectangle.
                // Duck-typed dumb objects are allowed.
                let compare_fields = (
                    compare_object.get_local_stored("x", activation),
                    compare_object.get_local_stored("y", activation),
                    compare_object.get_local_stored("width", activation),
                    compare_object.get_local_stored("height", activation),
                );
                match compare_fields {
                    // BitmapData vs. point
                    (Some(test_x), Some(test_y), None, None) => {
                        let test_point = (
                            test_x.coerce_to_i32(activation)? - top_left.0,
                            test_y.coerce_to_i32(activation)? - top_left.1,
                        );
                        return Ok(Value::Bool(operations::hit_test_point(
                            bitmap_data.bitmap_data_wrapper(),
                            source_threshold,
                            test_point,
                        )));
                    }

                    // BitmapData vs. rectangle
                    (Some(test_x), Some(test_y), Some(test_width), Some(test_height)) => {
                        let test_point = (
                            test_x.coerce_to_i32(activation)? - top_left.0,
                            test_y.coerce_to_i32(activation)? - top_left.1,
                        );
                        let size = (
                            test_width.coerce_to_i32(activation)?,
                            test_height.coerce_to_i32(activation)?,
                        );
                        return Ok(Value::Bool(operations::hit_test_rectangle(
                            bitmap_data.bitmap_data_wrapper(),
                            source_threshold,
                            test_point,
                            size,
                        )));
                    }

                    // Invalid compare object.
                    _ => {
                        return Ok((-3).into());
                    }
                }
            }
        }
    }

    // Disposed or invalid bitmap.
    Ok((-1).into())
}

pub fn copy_pixels<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let source_bitmap = args
                .get(0)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let source_rect = args
                .get(1)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let src_min_x = source_rect
                .get("x", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_min_y = source_rect
                .get("y", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_width = source_rect
                .get("width", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_height = source_rect
                .get("height", activation)?
                .coerce_to_f64(activation)? as i32;

            let dest_point = args
                .get(2)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let dest_x = dest_point.get("x", activation)?.coerce_to_f64(activation)? as i32;
            let dest_y = dest_point.get("y", activation)?.coerce_to_f64(activation)? as i32;

            if let Some(src_bitmap) = source_bitmap.as_bitmap_data_object() {
                if !src_bitmap.disposed() {
                    let merge_alpha = if args.len() >= 6 {
                        Some(
                            args.get(5)
                                .unwrap_or(&Value::Undefined)
                                .as_bool(activation.swf_version()),
                        )
                    } else {
                        None
                    };

                    let alpha_bitmap = args
                        .get(3)
                        .unwrap_or(&Value::Undefined)
                        .coerce_to_object(activation);

                    if let Some(alpha_bitmap) = alpha_bitmap.as_bitmap_data_object() {
                        if !alpha_bitmap.disposed() {
                            let alpha_point = args
                                .get(4)
                                .unwrap_or(&Value::Undefined)
                                .coerce_to_object(activation);

                            let alpha_x = alpha_point
                                .get("x", activation)?
                                .coerce_to_f64(activation)?
                                as i32;

                            let alpha_y = alpha_point
                                .get("y", activation)?
                                .coerce_to_f64(activation)?
                                as i32;

                            operations::copy_pixels_with_alpha_source(
                                &mut activation.context,
                                bitmap_data.bitmap_data_wrapper(),
                                src_bitmap.bitmap_data_wrapper(),
                                (src_min_x, src_min_y, src_width, src_height),
                                (dest_x, dest_y),
                                alpha_bitmap.bitmap_data_wrapper(),
                                (alpha_x, alpha_y),
                                merge_alpha.unwrap_or(true),
                            );
                        }
                    } else {
                        operations::copy_pixels(
                            &mut activation.context,
                            bitmap_data.bitmap_data_wrapper(),
                            src_bitmap.bitmap_data_wrapper(),
                            (src_min_x, src_min_y, src_width, src_height),
                            (dest_x, dest_y),
                            // Despite what the docs claim, mergeAlpa appears to be treated as 'false'
                            // when no 'alphaBitmap' is specified (e.g. only 3 args are passed)
                            merge_alpha.unwrap_or(false),
                        );
                    }
                }
            }

            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn merge<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let source_bitmap = args
                .get(0)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let source_rect = args
                .get(1)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let src_min_x = source_rect
                .get("x", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_min_y = source_rect
                .get("y", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_width = source_rect
                .get("width", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_height = source_rect
                .get("height", activation)?
                .coerce_to_f64(activation)? as i32;

            let dest_point = args
                .get(2)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let dest_x = dest_point.get("x", activation)?.coerce_to_f64(activation)? as i32;
            let dest_y = dest_point.get("y", activation)?.coerce_to_f64(activation)? as i32;

            let red_mult = args
                .get(3)
                .unwrap_or(&Value::Undefined)
                .coerce_to_i32(activation)?;

            let green_mult = args
                .get(4)
                .unwrap_or(&Value::Undefined)
                .coerce_to_i32(activation)?;

            let blue_mult = args
                .get(5)
                .unwrap_or(&Value::Undefined)
                .coerce_to_i32(activation)?;

            let alpha_mult = args
                .get(6)
                .unwrap_or(&Value::Undefined)
                .coerce_to_i32(activation)?;

            if let Some(src_bitmap) = source_bitmap.as_bitmap_data_object() {
                if !src_bitmap.disposed() {
                    operations::merge(
                        &mut activation.context,
                        bitmap_data.bitmap_data_wrapper(),
                        src_bitmap.bitmap_data_wrapper(),
                        (src_min_x, src_min_y, src_width, src_height),
                        (dest_x, dest_y),
                        (red_mult, green_mult, blue_mult, alpha_mult),
                    );
                }
            }

            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn palette_map<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let source_bitmap = args
                .get(0)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let source_rect = args
                .get(1)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let src_min_x = source_rect
                .get("x", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_min_y = source_rect
                .get("y", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_width = source_rect
                .get("width", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_height = source_rect
                .get("height", activation)?
                .coerce_to_f64(activation)? as i32;

            let dest_point = args
                .get(2)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let dest_x = dest_point.get("x", activation)?.coerce_to_f64(activation)? as i32;
            let dest_y = dest_point.get("y", activation)?.coerce_to_f64(activation)? as i32;

            let mut get_channel = |index: usize, shift: usize| -> Result<[u32; 256], Error<'gc>> {
                let arg = args.get(index).unwrap_or(&Value::Null);
                let mut array = [0_u32; 256];
                for (i, item) in array.iter_mut().enumerate() {
                    *item = if let Value::Object(arg) = arg {
                        arg.get_element(activation, i as i32)
                            .coerce_to_u32(activation)?
                    } else {
                        // This is an "identity mapping", fulfilling the part of the spec that
                        // says that channels which have no array provided are simply copied.
                        (i << shift) as u32
                    }
                }
                Ok(array)
            };

            let red_array = get_channel(3, 16)?;
            let green_array = get_channel(4, 8)?;
            let blue_array = get_channel(5, 0)?;
            let alpha_array = get_channel(6, 24)?;

            if let Some(src_bitmap) = source_bitmap.as_bitmap_data_object() {
                if !src_bitmap.disposed() {
                    operations::palette_map(
                        &mut activation.context,
                        bitmap_data.bitmap_data_wrapper(),
                        src_bitmap.bitmap_data_wrapper(),
                        (src_min_x, src_min_y, src_width, src_height),
                        (dest_x, dest_y),
                        (red_array, green_array, blue_array, alpha_array),
                    );
                }
            }

            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn pixel_dissolve<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    _args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            avm1_stub!(activation, "BitmapData", "pixelDissolve");
            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn scroll<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let x = args
                .get(0)
                .unwrap_or(&Value::Undefined)
                .coerce_to_i32(activation)?;
            let y = args
                .get(1)
                .unwrap_or(&Value::Undefined)
                .coerce_to_i32(activation)?;

            operations::scroll(
                &mut activation.context,
                bitmap_data.bitmap_data_wrapper(),
                x,
                y,
            );

            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn threshold<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    if let Some(bitmap_data) = this.as_bitmap_data_object() {
        if !bitmap_data.disposed() {
            let source_bitmap = args
                .get(0)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let source_rect = args
                .get(1)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let src_min_x = source_rect
                .get("x", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_min_y = source_rect
                .get("y", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_width = source_rect
                .get("width", activation)?
                .coerce_to_f64(activation)? as i32;
            let src_height = source_rect
                .get("height", activation)?
                .coerce_to_f64(activation)? as i32;

            let dest_point = args
                .get(2)
                .unwrap_or(&Value::Undefined)
                .coerce_to_object(activation);

            let dest_x = dest_point.get("x", activation)?.coerce_to_f64(activation)? as i32;
            let dest_y = dest_point.get("y", activation)?.coerce_to_f64(activation)? as i32;

            let operation = args.get(3);
            let operation = match ThresholdOperation::from_wstr(
                &operation
                    .unwrap_or(&Value::Undefined)
                    .coerce_to_string(activation)?,
            ) {
                Some(operation) => operation,
                None => return Ok(0.into()),
            };

            let threshold = args
                .get(4)
                .unwrap_or(&Value::Undefined)
                .coerce_to_u32(activation)?;

            let colour = args.get(5).unwrap_or(&0.into()).coerce_to_i32(activation)?;

            let mask = args
                .get(6)
                .unwrap_or(&0xFFFFFFFFu32.into())
                .coerce_to_u32(activation)?;

            let copy_source = args
                .get(7)
                .unwrap_or(&false.into())
                .as_bool(activation.swf_version());

            if let Some(src_bitmap) = source_bitmap.as_bitmap_data_object() {
                if !src_bitmap.disposed() {
                    let modified_count = operations::threshold(
                        &mut activation.context,
                        bitmap_data.bitmap_data_wrapper(),
                        src_bitmap.bitmap_data_wrapper(),
                        (src_min_x, src_min_y, src_width, src_height),
                        (dest_x, dest_y),
                        operation,
                        threshold,
                        colour,
                        mask,
                        copy_source,
                    );

                    return Ok(modified_count.into());
                }
            }

            return Ok(Value::Undefined);
        }
    }

    Ok((-1).into())
}

pub fn compare<'gc>(
    activation: &mut Activation<'_, 'gc>,
    this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    const EQUIVALENT: i32 = 0;
    const NOT_BITMAP: i32 = -1;
    const BITMAP_DISPOSED: i32 = -2;
    const DIFFERENT_WIDTHS: i32 = -3;
    const DIFFERENT_HEIGHTS: i32 = -4;

    let this_bitmap_data = if let Some(bitmap_data) = this.as_bitmap_data_object() {
        bitmap_data
    } else {
        return Ok(NOT_BITMAP.into());
    };

    if this_bitmap_data.disposed() {
        // The documentation says that -2 should be returned here, but -1 is actually returned.
        return Ok(NOT_BITMAP.into());
    }

    let other = args
        .get(0)
        .unwrap_or(&Value::Undefined)
        .coerce_to_object(activation);

    let other_bitmap_data = if let Some(other_bitmap_data) = other.as_bitmap_data_object() {
        other_bitmap_data
    } else {
        // The documentation says that -1 should be returned here, but -2 is actually returned.
        return Ok(BITMAP_DISPOSED.into());
    };

    if other_bitmap_data.disposed() {
        return Ok(BITMAP_DISPOSED.into());
    }

    let this_bitmap_data = this_bitmap_data.bitmap_data_wrapper();
    let other_bitmap_data = other_bitmap_data.bitmap_data_wrapper();

    if this_bitmap_data.width() != other_bitmap_data.width() {
        return Ok(DIFFERENT_WIDTHS.into());
    }

    if this_bitmap_data.height() != other_bitmap_data.height() {
        return Ok(DIFFERENT_HEIGHTS.into());
    }

    match operations::compare(this_bitmap_data, other_bitmap_data) {
        Some(bitmap_data) => Ok(BitmapDataObject::with_bitmap_data(
            activation.context.gc_context,
            activation.context.avm1.prototypes().bitmap_data,
            bitmap_data,
        )
        .into()),
        None => Ok(EQUIVALENT.into()),
    }
}

pub fn create_proto<'gc>(
    gc_context: MutationContext<'gc, '_>,
    proto: Object<'gc>,
    fn_proto: Object<'gc>,
) -> Object<'gc> {
    let bitmap_data_object = BitmapDataObject::empty_object(gc_context, proto);
    let object = bitmap_data_object.raw_script_object();
    define_properties_on(PROTO_DECLS, gc_context, object, fn_proto);
    bitmap_data_object.into()
}

pub fn load_bitmap<'gc>(
    activation: &mut Activation<'_, 'gc>,
    _this: Object<'gc>,
    args: &[Value<'gc>],
) -> Result<Value<'gc>, Error<'gc>> {
    let name = args
        .get(0)
        .unwrap_or(&Value::Undefined)
        .coerce_to_string(activation)?;

    let library = &*activation.context.library;

    let movie = activation.target_clip_or_root().movie();

    let character = library
        .library_for_movie(movie)
        .and_then(|l| l.character_by_export_name(name));

    if let Some(Character::Bitmap(bitmap)) = character {
        let new_bitmap_data = BitmapDataObject::empty_object(
            activation.context.gc_context,
            activation.context.avm1.prototypes().bitmap_data,
        );

        let width = bitmap.width() as u32;
        let height = bitmap.height() as u32;

        let pixels: Vec<_> = bitmap.bitmap_data().read().pixels().to_vec();

        new_bitmap_data
            .as_bitmap_data_object()
            .unwrap()
            .bitmap_data()
            .write(activation.context.gc_context)
            .set_pixels(width, height, true, pixels);

        return Ok(new_bitmap_data.into());
    }

    Ok(Value::Undefined)
}

pub fn create_bitmap_data_object<'gc>(
    gc_context: MutationContext<'gc, '_>,
    bitmap_data_proto: Object<'gc>,
    fn_proto: Object<'gc>,
) -> Object<'gc> {
    let bitmap_data = FunctionObject::constructor(
        gc_context,
        Executable::Native(constructor),
        constructor_to_fn!(constructor),
        fn_proto,
        bitmap_data_proto,
    );
    let object = bitmap_data.raw_script_object();
    define_properties_on(OBJECT_DECLS, gc_context, object, fn_proto);
    bitmap_data
}
